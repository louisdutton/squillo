type Band = {
  low: number;
  high: number;
};

type Analysis = {
  pitch: number | null;
  note: string;
  squilloRatio: number;
  brightness: number;
  bandPeak: number;
};

const startButton = requireElement<HTMLButtonElement>("#startButton");
const pitchValue = requireElement<HTMLElement>("#pitchValue");
const noteValue = requireElement<HTMLElement>("#noteValue");
const squilloValue = requireElement<HTMLElement>("#squilloValue");
const brightnessValue = requireElement<HTMLElement>("#brightnessValue");
const gainControl = requireElement<HTMLInputElement>("#gainControl");
const bandControl = requireElement<HTMLSelectElement>("#bandControl");
const spectrumCanvas = requireElement<HTMLCanvasElement>("#spectrumCanvas");
const spectrogramCanvas = requireElement<HTMLCanvasElement>("#spectrogramCanvas");

const spectrumCtx = getCanvasContext(spectrumCanvas);
const spectrogramCtx = getCanvasContext(spectrogramCanvas);
const fftSize = 8192;
const minPitchHz = 45;
const maxPitchHz = 1100;
const minPitchRms = 0.0025;
const minPitchConfidence = 0.38;
const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let gainNode: GainNode | null = null;
let mediaStream: MediaStream | null = null;
let frequencyData = new Float32Array(0);
let timeData = new Float32Array(0);
let animationHandle = 0;
let smoothedSquillo = 0;
let smoothedBrightness = 0;

drawIdle();

startButton.addEventListener("click", () => {
  if (audioContext) {
    stopAudio();
    return;
  }

  void startAudio();
});

gainControl.addEventListener("input", () => {
  if (gainNode) {
    gainNode.gain.value = Number(gainControl.value);
  }
});

async function startAudio(): Promise<void> {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  gainNode = audioContext.createGain();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.minDecibels = -110;
  analyser.maxDecibels = -18;
  analyser.smoothingTimeConstant = 0.62;
  gainNode.gain.value = Number(gainControl.value);
  source.connect(gainNode).connect(analyser);

  frequencyData = new Float32Array(analyser.frequencyBinCount);
  timeData = new Float32Array(analyser.fftSize);

  startButton.textContent = "Stop Mic";
  startButton.dataset.active = "true";
  animationHandle = requestAnimationFrame(drawFrame);
}

function stopAudio(): void {
  cancelAnimationFrame(animationHandle);
  mediaStream?.getTracks().forEach((track) => track.stop());
  void audioContext?.close();

  audioContext = null;
  analyser = null;
  gainNode = null;
  mediaStream = null;
  startButton.textContent = "Start Mic";
  startButton.dataset.active = "false";
  pitchValue.textContent = "--";
  noteValue.textContent = "--";
  squilloValue.textContent = "--";
  brightnessValue.textContent = "--";
  drawIdle();
}

function drawFrame(): void {
  if (!audioContext || !analyser) {
    return;
  }

  analyser.getFloatFrequencyData(frequencyData);
  analyser.getFloatTimeDomainData(timeData);

  const band = parseBand(bandControl.value);
  const analysis = analyseVoice(audioContext.sampleRate, band);
  renderMeters(analysis);
  drawSpectrum(audioContext.sampleRate, band, analysis);
  drawSpectrogram(audioContext.sampleRate, band);

  animationHandle = requestAnimationFrame(drawFrame);
}

function analyseVoice(sampleRate: number, band: Band): Analysis {
  const pitch = estimatePitch(sampleRate);
  const note = pitch ? frequencyToNote(pitch) : "--";
  const squillo = bandEnergy(sampleRate, band.low, band.high);
  const body = bandEnergy(sampleRate, 300, 1800);
  const high = bandEnergy(sampleRate, 1800, 5000);
  const total = bandEnergy(sampleRate, 120, 5000);
  const bandPeak = peakFrequency(sampleRate, band.low, band.high);

  smoothedSquillo = smooth(smoothedSquillo, squillo / Math.max(body, 0.000001), 0.18);
  smoothedBrightness = smooth(smoothedBrightness, high / Math.max(total, 0.000001), 0.14);

  return {
    pitch,
    note,
    squilloRatio: smoothedSquillo,
    brightness: smoothedBrightness,
    bandPeak,
  };
}

function estimatePitch(sampleRate: number): number | null {
  const minLag = Math.floor(sampleRate / maxPitchHz);
  const maxLag = Math.floor(sampleRate / minPitchHz);
  let bestLag = -1;
  let bestCorrelation = -Infinity;
  let signalEnergy = 0;

  for (const sample of timeData) {
    signalEnergy += sample * sample;
  }

  const rms = Math.sqrt(signalEnergy / timeData.length);

  if (rms < minPitchRms) {
    return null;
  }

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;

    for (let index = 0; index < timeData.length - lag; index += 1) {
      const left = timeData[index];
      const right = timeData[index + lag];
      correlation += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }

    correlation /= Math.sqrt(leftEnergy * rightEnergy) || 1;

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestCorrelation < minPitchConfidence) {
    return null;
  }

  return sampleRate / bestLag;
}

function bandEnergy(sampleRate: number, lowHz: number, highHz: number): number {
  const lowBin = hzToBin(sampleRate, lowHz);
  const highBin = hzToBin(sampleRate, highHz);
  let total = 0;

  for (let bin = lowBin; bin <= highBin; bin += 1) {
    const linear = Math.pow(10, frequencyData[bin] / 20);
    total += linear * linear;
  }

  return total / Math.max(1, highBin - lowBin + 1);
}

function peakFrequency(sampleRate: number, lowHz: number, highHz: number): number {
  const lowBin = hzToBin(sampleRate, lowHz);
  const highBin = hzToBin(sampleRate, highHz);
  let bestBin = lowBin;
  let bestDb = -Infinity;

  for (let bin = lowBin; bin <= highBin; bin += 1) {
    if (frequencyData[bin] > bestDb) {
      bestDb = frequencyData[bin];
      bestBin = bin;
    }
  }

  return binToHz(sampleRate, bestBin);
}

function drawSpectrum(sampleRate: number, band: Band, analysis: Analysis): void {
  const width = spectrumCanvas.width;
  const height = spectrumCanvas.height;
  spectrumCtx.clearRect(0, 0, width, height);
  spectrumCtx.fillStyle = "#080a0b";
  spectrumCtx.fillRect(0, 0, width, height);

  drawBand(width, height, band, sampleRate);
  drawGrid(spectrumCtx, width, height);

  spectrumCtx.beginPath();
  for (let bin = 1; bin < frequencyData.length; bin += 1) {
    const hz = binToHz(sampleRate, bin);
    if (hz > 6000) {
      break;
    }

    const x = frequencyToX(hz, width);
    const y = dbToY(frequencyData[bin], height);

    if (bin === 1) {
      spectrumCtx.moveTo(x, y);
    } else {
      spectrumCtx.lineTo(x, y);
    }
  }
  spectrumCtx.lineWidth = 2;
  spectrumCtx.strokeStyle = "#f5d46f";
  spectrumCtx.stroke();

  if (analysis.pitch) {
    drawHarmonics(analysis.pitch, width, height);
  }

  drawLabel(spectrumCtx, `Singer's formant peak ${Math.round(analysis.bandPeak)} Hz`, 18, 32);
}

function drawSpectrogram(sampleRate: number, band: Band): void {
  const width = spectrogramCanvas.width;
  const height = spectrogramCanvas.height;
  const image = spectrogramCtx.getImageData(1, 0, width - 1, height);
  spectrogramCtx.putImageData(image, 0, 0);

  for (let y = 0; y < height; y += 1) {
    const hz = yToFrequency(height - y, height);
    const bin = hzToBin(sampleRate, hz);
    const intensity = clamp((frequencyData[bin] + 105) / 72, 0, 1);
    spectrogramCtx.fillStyle = heatColor(intensity, hz >= band.low && hz <= band.high);
    spectrogramCtx.fillRect(width - 1, y, 1, 1);
  }
}

function drawBand(width: number, height: number, band: Band, sampleRate: number): void {
  const x1 = frequencyToX(band.low, width);
  const x2 = frequencyToX(band.high, width);
  spectrumCtx.fillStyle = "rgba(173, 45, 68, 0.28)";
  spectrumCtx.fillRect(x1, 0, x2 - x1, height);
  spectrumCtx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  spectrumCtx.setLineDash([8, 8]);
  spectrumCtx.beginPath();
  spectrumCtx.moveTo(x1, 0);
  spectrumCtx.lineTo(x1, height);
  spectrumCtx.moveTo(x2, 0);
  spectrumCtx.lineTo(x2, height);
  spectrumCtx.stroke();
  spectrumCtx.setLineDash([]);
  drawLabel(spectrumCtx, `${band.low / 1000}-${band.high / 1000} kHz`, x1 + 10, height - 18);

  for (const hz of [500, 1000, 2000, 3000, 4000, 5000, 6000]) {
    const x = frequencyToX(hz, width);
    drawLabel(spectrumCtx, `${hz / 1000}k`, x + 4, height - 42);
  }

  void sampleRate;
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;

  for (const db of [-90, -70, -50, -30]) {
    const y = dbToY(db, height);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    drawLabel(ctx, `${db} dB`, 12, y - 6);
  }
}

function drawHarmonics(pitch: number, width: number, height: number): void {
  spectrumCtx.strokeStyle = "rgba(132, 207, 176, 0.72)";
  spectrumCtx.lineWidth = 1;

  for (let harmonic = 1; harmonic <= 24; harmonic += 1) {
    const hz = pitch * harmonic;
    if (hz > 6000) {
      break;
    }

    const x = frequencyToX(hz, width);
    spectrumCtx.beginPath();
    spectrumCtx.moveTo(x, 0);
    spectrumCtx.lineTo(x, height);
    spectrumCtx.stroke();
  }
}

function renderMeters(analysis: Analysis): void {
  pitchValue.textContent = analysis.pitch ? `${Math.round(analysis.pitch)} Hz` : "--";
  noteValue.textContent = analysis.note;
  squilloValue.textContent = `${analysis.squilloRatio.toFixed(2)}x`;
  brightnessValue.textContent = `${Math.round(analysis.brightness * 100)}%`;
}

function drawIdle(): void {
  for (const canvas of [spectrumCanvas, spectrogramCanvas]) {
    const ctx = getCanvasContext(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#080a0b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawLabel(ctx, "Start mic to analyse live harmonics", 22, 34);
  }
}

function parseBand(value: string): Band {
  const [low, high] = value.split(",").map(Number);
  return { low, high };
}

function frequencyToNote(frequency: number): string {
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  const name = noteNames[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  const cents = Math.round(1200 * Math.log2(frequency / midiToFrequency(midi)));
  const sign = cents > 0 ? "+" : "";
  return `${name}${octave} ${sign}${cents}`;
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function hzToBin(sampleRate: number, hz: number): number {
  return clamp(Math.round((hz / sampleRate) * fftSize), 0, frequencyData.length - 1);
}

function binToHz(sampleRate: number, bin: number): number {
  return (bin * sampleRate) / fftSize;
}

function frequencyToX(hz: number, width: number): number {
  const min = Math.log10(80);
  const max = Math.log10(6000);
  return ((Math.log10(clamp(hz, 80, 6000)) - min) / (max - min)) * width;
}

function yToFrequency(y: number, height: number): number {
  const min = Math.log10(80);
  const max = Math.log10(6000);
  return 10 ** (min + (y / height) * (max - min));
}

function dbToY(db: number, height: number): number {
  return (1 - clamp((db + 105) / 88, 0, 1)) * height;
}

function heatColor(value: number, inBand: boolean): string {
  const r = Math.round(24 + value * 231);
  const g = Math.round(34 + value * (inBand ? 202 : 118));
  const b = Math.round(42 + value * (inBand ? 72 : 34));
  return `rgb(${r}, ${g}, ${b})`;
}

function smooth(previous: number, next: number, factor: number): number {
  return previous + (next - previous) * factor;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.fillStyle = "rgba(244, 241, 232, 0.78)";
  ctx.font = "15px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(text, x, y);
}

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas 2D context is unavailable.");
  }

  return ctx;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}
