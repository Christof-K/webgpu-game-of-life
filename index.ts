
if (!navigator.gpu) {
  throw new Error("WebGPU not suported on this browser");
}

const canvas = document.querySelector("canvas");
if (!canvas) throw new Error("Canvas not found");

canvas.width = canvas.clientWidth * devicePixelRatio;
canvas.height = canvas.clientHeight * devicePixelRatio;


const cellShaderPromise = fetch("/shaders/cellShader.wgsl").then(res => res.text())
const simulationShaderPromise = fetch("/shaders/simulationShader.wgsl").then(res => res.text());


navigator.gpu.requestAdapter().then(
  (adapter: GPUAdapter | null) => {
    if (!adapter) throw new Error("Adapter not found")
    adapter.requestDevice().then((device: GPUDevice | null) => {
      if (!device) throw new Error("device not found")
      const context = canvas.getContext("webgpu");
      if (!context) throw new Error("Context not found")
      const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

      context.configure({
        device: device,
        format: canvasFormat,
        alphaMode: "premultiplied",
      });

      Promise.all([cellShaderPromise, simulationShaderPromise]).then(([cellShader, simulationShader]) => {
        main({
          device: device,
          cellShader: cellShader,
          simulationShader: simulationShader,
          canvasFormat: canvasFormat,
          context: context
        });
      })
    });
  },
  () => {
    throw new Error("No appropriate GPUAdapter found.");
  }
);


interface IMain {
  device: GPUDevice
  cellShader: string
  simulationShader: string
  canvasFormat: GPUTextureFormat
  context: GPUCanvasContext
}

function main(props: IMain) {

  const GRID_SIZE = 256;
  const UPDATE_INTERVAL = 100;
  const WORKGROUP_SIZE = 8;

  let step = 0;

  const squareVertices = new Float32Array([
    -0.8,
    -0.8,
    0.8,
    -0.8,
    0.8,
    0.8,

    -0.8,
    -0.8,
    0.8,
    0.8,
    -0.8,
    0.8,
  ]);

  // square buffer
  const vertexBuffer = props.device.createBuffer({
    label: "Cell vertices",
    size: squareVertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  props.device.queue.writeBuffer(vertexBuffer, /*bufferOffset=*/ 0, squareVertices);

  const vertexBufferLayout = {
    arrayStride: 8,
    attributes: [
      {
        format: "float32x2",
        offset: 0,
        shaderLocation: 0,
      },
    ],
  };

  // grid buffer
  const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
  const uniformBuffer = props.device.createBuffer({
    label: "Grid Uniforms",
    size: uniformArray.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  props.device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

  // storage buffer
  const cellSizeStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);
  const cellSizeStateStorage = props.device.createBuffer({
    label: "Cell size state",
    size: cellSizeStateArray.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });

  const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);
  const cellStateStorage = [
    props.device.createBuffer({
      label: "Cell State A",
      size: cellStateArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    props.device.createBuffer({
      label: "Cell State B",
      size: cellStateArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
  ];

  // Mark every third cell of the first grid as active.
  for (let i = 0; i < cellStateArray.length; ++i) {
    cellStateArray[i] = Math.random() > 0.94 ? 1 : 0;
  }
  props.device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);
  // Mark every other cell of the second grid as active.
  for (let i = 0; i < cellStateArray.length; i++) {
    cellStateArray[i] = i % 2;
  }
  props.device.queue.writeBuffer(cellStateStorage[1], 0, cellStateArray);

  for (let i = 0; i < cellSizeStateArray.length; i++) {
    cellSizeStateArray[i] = 1;
  }
  props.device.queue.writeBuffer(cellSizeStateStorage, 0, cellSizeStateArray)


  const cellShaderModule = props.device.createShaderModule({
    label: "Cell shader",
    code: props.cellShader,
  });


  // Create the compute shader that will process the simulation.
  const simulationShaderModule = props.device.createShaderModule({
    label: "Game of Life simulation shader",
    code: props.simulationShader
  });



  const bindGroupLayout = props.device.createBindGroupLayout({
    label: "Cell Bind Group Layout",
    entries: [
      {
        binding: 0,
        visibility:
          GPUShaderStage.VERTEX |
          GPUShaderStage.COMPUTE |
          GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
        buffer: { type: "storage" },
      },
    ],
  });


  const pipelineLayout = props.device.createPipelineLayout({
    label: "Cell Pipeline Layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  const simulationPipeline = props.device.createComputePipeline({
    label: "Simulation pipeline",
    layout: pipelineLayout,
    compute: {
      module: simulationShaderModule,
      entryPoint: "computeMain"
    }
  });


  const cellPipeline = props.device.createRenderPipeline({
    label: "Cell pipeline",
    layout: pipelineLayout,
    vertex: {
      module: cellShaderModule,
      entryPoint: "vertexMain",
      // @ts-ignore
      buffers: [vertexBufferLayout],
    },
    fragment: {
      module: cellShaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format: props.canvasFormat,
        },
      ],
    },
  });

  const bindGroups = [
    props.device.createBindGroup({
      label: "Cell renderer bind group A",
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: uniformBuffer },
        },
        {
          binding: 1,
          resource: { buffer: cellStateStorage[0] },
        },
        {
          binding: 2,
          resource: { buffer: cellStateStorage[1] },
        },
        {
          binding: 3,
          resource: { buffer: cellSizeStateStorage },
        },
      ],
    }),
    props.device.createBindGroup({
      label: "Cell renderer bind group B",
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: uniformBuffer },
        },
        {
          binding: 1,
          resource: { buffer: cellStateStorage[1] },
        },
        {
          binding: 2,
          resource: { buffer: cellStateStorage[0] },
        },
        {
          binding: 3,
          resource: { buffer: cellSizeStateStorage },
        },
      ],
    }),
  ];

  // Move all of our rendering code into a function
  function updateGrid() {
    const encoder = props.device.createCommandEncoder();
    const computePass = encoder.beginComputePass();

    computePass.setPipeline(simulationPipeline);
    computePass.setBindGroup(0, bindGroups[step % 2]);

    const workgroupCount = Math.ceil(GRID_SIZE / WORKGROUP_SIZE);
    computePass.dispatchWorkgroups(workgroupCount, workgroupCount);

    computePass.end();

    step++; // Increment the step count
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: props.context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0.4, a: 1 }, // New line
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(cellPipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setBindGroup(0, bindGroups[step % 2]);

    pass.draw(squareVertices.length / 2, GRID_SIZE * GRID_SIZE);
    pass.end();

    // Finish the command buffer and immediately submit it.
    props.device.queue.submit([encoder.finish()]);
  }

  // Schedule updateGrid() to run repeatedly
  setInterval(updateGrid, UPDATE_INTERVAL);
}


