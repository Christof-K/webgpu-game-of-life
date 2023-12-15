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