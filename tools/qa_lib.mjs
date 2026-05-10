import { inflateSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function severityRank(severity) {
  return { P0: 4, P1: 3, P2: 2, P3: 1 }[severity] ?? 0;
}

export function scoreKeys() {
  return [
    'visual',
    'copy',
    'scenario',
    'event',
    'ending',
    'ux',
    'continuity',
    'commercial_polish',
  ];
}

export function pngDimensions(buffer) {
  assertPng(buffer);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

export async function readPng(path) {
  return parsePng(await readFile(path));
}

export function parsePng(buffer) {
  assertPng(buffer);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  }

  const channels = channelsForColorType(colorType);
  const inflated = inflateSync(Buffer.concat(idatParts));
  const rowBytes = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  let previous = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const current = Buffer.from(inflated.subarray(inputOffset, inputOffset + rowBytes));
    inputOffset += rowBytes;
    unfilter(current, previous, channels, filter);
    writeRgbaRow(rgba, current, y, width, channels, colorType);
    previous = current;
  }

  return { width, height, rgba };
}

export function analyzePngImage(image) {
  const { width, height, rgba } = image;
  const lumas = [];
  let whitePixels = 0;
  let blackPixels = 0;
  let brightLowSatPixels = 0;
  let saturationSum = 0;
  let lumaSum = 0;
  let edgeSum = 0;
  let edgeCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = rgba[index];
      const g = rgba[index + 1];
      const b = rgba[index + 2];
      const luma = luminance(r, g, b);
      const saturation = rgbSaturation(r, g, b);
      lumas.push(luma);
      lumaSum += luma;
      saturationSum += saturation;
      if (luma > 245) {
        whitePixels += 1;
      }
      if (luma < 10) {
        blackPixels += 1;
      }
      if (luma > 235 && saturation < 0.12) {
        brightLowSatPixels += 1;
      }
      if (x > 0 && y % 2 === 0 && x % 2 === 0) {
        const left = luminance(
          rgba[index - 4],
          rgba[index - 3],
          rgba[index - 2],
        );
        edgeSum += Math.abs(luma - left);
        edgeCount += 1;
      }
      if (y > 0 && y % 2 === 0 && x % 2 === 0) {
        const aboveIndex = ((y - 1) * width + x) * 4;
        const above = luminance(
          rgba[aboveIndex],
          rgba[aboveIndex + 1],
          rgba[aboveIndex + 2],
        );
        edgeSum += Math.abs(luma - above);
        edgeCount += 1;
      }
    }
  }

  lumas.sort((a, b) => a - b);
  const pixelCount = width * height;
  const meanLuma = lumaSum / pixelCount;
  const p05 = percentile(lumas, 0.05);
  const p95 = percentile(lumas, 0.95);
  const contrastRange = p95 - p05;
  const whiteRatio = whitePixels / pixelCount;
  const blackRatio = blackPixels / pixelCount;
  const brightLowSatRatio = brightLowSatPixels / pixelCount;
  const averageSaturation = saturationSum / pixelCount;
  const edgeNoise = edgeCount === 0 ? 0 : edgeSum / edgeCount / 255;
  const whiteBlockRatio = largestBrightBlockRatio(image);

  return {
    width,
    height,
    mean_luma: round(meanLuma),
    contrast_range: round(contrastRange),
    white_ratio: round(whiteRatio),
    black_ratio: round(blackRatio),
    bright_low_saturation_ratio: round(brightLowSatRatio),
    average_saturation: round(averageSaturation),
    edge_noise: round(edgeNoise),
    largest_bright_block_ratio: round(whiteBlockRatio),
  };
}

function assertPng(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Not a PNG file.');
  }
}

function channelsForColorType(colorType) {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`Unsupported PNG color type: ${colorType}`);
}

function unfilter(row, previous, bpp, filter) {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? previous[i - bpp] ?? 0 : 0;
    if (filter === 1) {
      row[i] = (row[i] + left) & 0xff;
    } else if (filter === 2) {
      row[i] = (row[i] + up) & 0xff;
    } else if (filter === 3) {
      row[i] = (row[i] + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
    } else if (filter !== 0) {
      throw new Error(`Unsupported PNG filter: ${filter}`);
    }
  }
}

function writeRgbaRow(rgba, row, y, width, channels, colorType) {
  for (let x = 0; x < width; x += 1) {
    const source = x * channels;
    const target = (y * width + x) * 4;
    if (colorType === 0) {
      rgba[target] = row[source];
      rgba[target + 1] = row[source];
      rgba[target + 2] = row[source];
      rgba[target + 3] = 255;
    } else if (colorType === 2) {
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      rgba[target] = row[source];
      rgba[target + 1] = row[source];
      rgba[target + 2] = row[source];
      rgba[target + 3] = row[source + 1];
    } else {
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = row[source + 3];
    }
  }
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbSaturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function percentile(sortedValues, position) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor(sortedValues.length * position)),
  );
  return sortedValues[index];
}

function largestBrightBlockRatio(image) {
  const columns = 20;
  const rows = 40;
  const brightCells = new Set();
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;

  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < columns; cx += 1) {
      const x0 = Math.floor(cx * cellWidth);
      const x1 = Math.floor((cx + 1) * cellWidth);
      const y0 = Math.floor(cy * cellHeight);
      const y1 = Math.floor((cy + 1) * cellHeight);
      let bright = 0;
      let total = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const index = (y * image.width + x) * 4;
          const luma = luminance(
            image.rgba[index],
            image.rgba[index + 1],
            image.rgba[index + 2],
          );
          const saturation = rgbSaturation(
            image.rgba[index],
            image.rgba[index + 1],
            image.rgba[index + 2],
          );
          if (luma > 235 && saturation < 0.14) {
            bright += 1;
          }
          total += 1;
        }
      }
      if (total > 0 && bright / total > 0.62) {
        brightCells.add(`${cx},${cy}`);
      }
    }
  }

  let maxCells = 0;
  const seen = new Set();
  for (const cell of brightCells) {
    if (seen.has(cell)) continue;
    const stack = [cell];
    seen.add(cell);
    let size = 0;
    while (stack.length > 0) {
      const current = stack.pop();
      size += 1;
      const [x, y] = current.split(',').map(Number);
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        const key = `${nx},${ny}`;
        if (brightCells.has(key) && !seen.has(key)) {
          seen.add(key);
          stack.push(key);
        }
      }
    }
    maxCells = Math.max(maxCells, size);
  }

  return maxCells / (columns * rows);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
