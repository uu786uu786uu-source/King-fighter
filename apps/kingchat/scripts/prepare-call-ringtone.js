#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sampleRate = 22050;
const durationSeconds = 18;
const sampleCount = sampleRate * durationSeconds;
const pcm = Buffer.alloc(sampleCount * 2);

// Five natural double-tone ring bursts, separated by short silences.
// The pattern is intentionally original and contains no third-party audio.
const burstStarts = [0, 0.62, 1.24];
const cycleLength = 3.6;
const cycles = 5;

for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  const cyclePosition = time % cycleLength;
  const cycleNumber = Math.floor(time / cycleLength);
  let active = false;
  let burstTime = 0;

  if (cycleNumber < cycles) {
    for (const start of burstStarts) {
      if (cyclePosition >= start && cyclePosition < start + 0.42) {
        active = true;
        burstTime = cyclePosition - start;
        break;
      }
    }
  }

  let value = 0;
  if (active) {
    const fadeSeconds = 0.012;
    const fadeIn = Math.min(1, burstTime / fadeSeconds);
    const fadeOut = Math.min(1, (0.42 - burstTime) / fadeSeconds);
    const envelope = Math.max(0, Math.min(fadeIn, fadeOut));
    const tone = (Math.sin(2 * Math.PI * 480 * time) +
      Math.sin(2 * Math.PI * 620 * time)) / 2;
    value = tone * envelope * 0.34;
  }

  pcm.writeInt16LE(Math.max(-1, Math.min(1, value)) * 32767, index * 2);
}

const wav = Buffer.alloc(44 + pcm.length);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + pcm.length, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(pcm.length, 40);
pcm.copy(wav, 44);

const output = path.join(__dirname, '..', 'assets', 'guftin_call_ringtone.wav');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, wav);
process.stderr.write('Generated Guftin incoming-call ringtone: ' + output + '\\n');
