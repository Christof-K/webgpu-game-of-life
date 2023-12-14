const canvas = document.querySelector("canvas");
if (!navigator.gpu) {
  throw new Error("WebGPI not supported on this browser");
}
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  throw new Error("No appropriate GPUAdapter found.");
}

const device = await adapter.requestDevice();
const context = canvas.getContext("webgpu");
const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

context.configure({
  device: device,
  format: canvasFormat,
});

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
const vertexBuffer = device.createBuffer({
  label: "Cell vertices",
  size: squareVertices.byteLength,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});

device.queue.writeBuffer(vertexBuffer, /*bufferOffset=*/ 0, squareVertices);

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
const uniformBuffer = device.createBuffer({
  label: "Grid Uniforms",
  size: uniformArray.byteLength,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

// storage buffer
const cellSizeStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);
const cellSizeStateStorage = device.createBuffer({
  label: "Cell size state",
  size: cellSizeStateArray.byteLength,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
});

const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);
const cellStateStorage = [
  device.createBuffer({
    label: "Cell State A",
    size: cellStateArray.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }),
  device.createBuffer({
    label: "Cell State B",
    size: cellStateArray.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }),
];

// Mark every third cell of the first grid as active.
for (let i = 0; i < cellStateArray.length; ++i) {
  cellStateArray[i] = Math.random() > 0.94 ? 1 : 0;
}
device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);
// Mark every other cell of the second grid as active.
for (let i = 0; i < cellStateArray.length; i++) {
  cellStateArray[i] = i % 2;
}
device.queue.writeBuffer(cellStateStorage[1], 0, cellStateArray);

for (let i = 0; i < cellSizeStateArray.length; i++) {
  cellSizeStateArray[i] = 1;
}
device.queue.writeBuffer(cellSizeStateStorage, 0, cellSizeStateArray)

const cellShader = `
    struct VertexInput {
      @location(0) pos: vec2f,
      @builtin(instance_index) instance: u32
    }

    struct VertexOutput {
      @builtin(position) pos: vec4f,
      @location(0) cell: vec2f,
      @location(1) @interpolate(flat) instance: u32
    }

    @group(0) @binding(0) var<uniform> grid: vec2f;
    @group(0) @binding(1) var<storage> cellState: array<u32>;
    @group(0) @binding(3) var<storage, read_write> cellSizeState: array<u32>;

    @vertex
    fn vertexMain(input: VertexInput) -> VertexOutput {

      let i = f32(input.instance);
      let cell = vec2f(i % grid.x, floor(i / grid.x));
      let state = f32(cellState[input.instance]);
      let cellOffset = cell / grid * 2;
      let gridPos = (input.pos * state + 1) / grid - 1 + cellOffset;

      var output: VertexOutput;
      output.pos = vec4f(gridPos, 0, 1);
      output.cell = cell;
      output.instance = input.instance;

      return output;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {

      let size = f32(cellSizeState[input.instance]);

      var red = size/10;
      var green = size/10;
      var blue = size/10;

      if(size > 4.0) {
        green = green * 10;
      } else if(size > 2.0) {
        red = red * 4;
      } else {
        blue = blue * 10;
      }

      let color = vec4f(red, green, blue, 1);
      return color;
    }
`;

const cellShaderModule = device.createShaderModule({
  label: "Cell shader",
  code: cellShader,
});


const simulationShader = `
   @group(0) @binding(0) var<uniform> grid: vec2f;

    @group(0) @binding(1) var<storage> cellStateIn: array<u32>;
    @group(0) @binding(2) var<storage, read_write> cellStateOut: array<u32>;
    @group(0) @binding(3) var<storage, read_write> cellSizeState: array<u32>;

    fn cellIndex(cell: vec2u) -> u32 {
      return (cell.y % u32(grid.y)) * u32(grid.x) +
              (cell.x % u32(grid.x));
    }

    fn cellActive(x: u32, y: u32) -> u32 {
      return cellStateIn[cellIndex(vec2(x, y))];
    }

    @compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
    fn computeMain(@builtin(global_invocation_id) cell: vec3u) {
      // Determine how many active neighbors this cell has.
      let activeNeighbors = cellActive(cell.x+1, cell.y+1) +
                            cellActive(cell.x+1, cell.y) +
                            cellActive(cell.x+1, cell.y-1) +
                            cellActive(cell.x, cell.y-1) +
                            cellActive(cell.x-1, cell.y-1) +
                            cellActive(cell.x-1, cell.y) +
                            cellActive(cell.x-1, cell.y+1) +
                            cellActive(cell.x, cell.y+1);

      let i = cellIndex(cell.xy);

      cellSizeState[i] = activeNeighbors;

      // Conway's game of life rules:
      switch activeNeighbors {
        case 1,2: {
          cellStateOut[i] = cellStateIn[i];
        }
        case 3,5,10: {
          cellStateOut[i] = 1;
        }
        default: {
          cellStateOut[i] = 0;
        }
      }
    }
`;

// Create the compute shader that will process the simulation.
const simulationShaderModule = device.createShaderModule({
  label: "Game of Life simulation shader",
  code: simulationShader
});



const bindGroupLayout = device.createBindGroupLayout({
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


const pipelineLayout = device.createPipelineLayout({
  label: "Cell Pipeline Layout",
  bindGroupLayouts: [bindGroupLayout],
});

const simulationPipeline = device.createComputePipeline({
  label: "Simulation pipeline",
  layout: pipelineLayout,
  compute: {
    module: simulationShaderModule,
    entryPoint: "computeMain"
  }
});


const cellPipeline = device.createRenderPipeline({
  label: "Cell pipeline",
  layout: pipelineLayout,
  vertex: {
    module: cellShaderModule,
    entryPoint: "vertexMain",
    buffers: [vertexBufferLayout],
  },
  fragment: {
    module: cellShaderModule,
    entryPoint: "fragmentMain",
    targets: [
      {
        format: canvasFormat,
      },
    ],
  },
});

const bindGroups = [
  device.createBindGroup({
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
  device.createBindGroup({
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
  const encoder = device.createCommandEncoder();
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
        view: context.getCurrentTexture().createView(),
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
  device.queue.submit([encoder.finish()]);
}

// Schedule updateGrid() to run repeatedly
setInterval(updateGrid, UPDATE_INTERVAL);
