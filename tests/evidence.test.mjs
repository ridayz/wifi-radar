import test from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry, integrate } from '../src/collector/index.mjs';

function sample(t, rx, tx) {
  return { t, rxBps: rx, txBps: tx };
}

test('integrates rates into byte totals', () => {
  const result = integrate([sample(0, 100, 10), sample(1000, 200, 20), sample(2000, 300, 30)]);
  assert.equal(result.totalRxBytes, 500);
  assert.equal(result.totalTxBytes, 50);
  assert.deepEqual(result.gaps, { count: 0, totalSec: 0, maxSec: 0 });
});

test('reports gaps instead of summing unmeasured seconds', () => {
  const result = integrate([sample(0, 100, 10), sample(1000, 100, 10), sample(101_000, 100, 10)]);
  assert.equal(result.totalRxBytes, 100);
  assert.deepEqual(result.gaps, { count: 1, totalSec: 100, maxSec: 100 });
});

test('merges recording over history per second, oldest first', () => {
  const telemetry = new Telemetry();
  telemetry.link = { connected: true, ssid: 'Enso', bssid: 'aa:bb:cc:dd:ee:ff', channel: 11 };
  telemetry.history.traffic = [
    { t: 1000, rx: 10, tx: 1 },
    { t: 2000, rx: 20, tx: 2 },
    { t: 3000, rx: 30, tx: 3 },
  ];
  telemetry.recording.samples = [
    {
      t: 2000,
      iso: new Date(2000).toISOString(),
      rxBps: 999,
      txBps: 99,
      signalPct: 80,
      rssiDbm: -60,
      latencyGwMs: 5,
      latencyNetMs: 20,
      lossNetPct: 0,
      dnsMs: 30,
      clientsOnline: 7,
      ssid: 'Enso',
      bssid: 'aa:bb:cc:dd:ee:ff',
      channel: 11,
    },
  ];

  const merged = telemetry.mergedSamples();
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((s) => s.t),
    [1000, 2000, 3000],
  );
  const recorded = merged.find((s) => s.t === 2000);
  assert.equal(recorded.rxBps, 999);
  assert.equal(recorded.clientsOnline, 7);
});

test('session scope includes history even when a recording exists', () => {
  const telemetry = new Telemetry();
  telemetry.link = { connected: true, ssid: 'Enso' };
  telemetry.history.traffic = [
    { t: 1000, rx: 10, tx: 1 },
    { t: 2000, rx: 20, tx: 2 },
    { t: 3000, rx: 30, tx: 3 },
  ];
  telemetry.recording = {
    active: false,
    startedAt: 2000,
    samples: [
      {
        t: 2000,
        iso: new Date(2000).toISOString(),
        rxBps: 20,
        txBps: 2,
        signalPct: 80,
        rssiDbm: -60,
        latencyGwMs: 5,
        latencyNetMs: 20,
        lossNetPct: 0,
        dnsMs: 30,
        clientsOnline: 7,
        ssid: 'Enso',
        bssid: null,
        channel: 11,
      },
    ],
  };

  assert.equal(telemetry.evidence({ scope: 'session' }).samples.length, 3);
  assert.equal(telemetry.evidence({ scope: 'session' }).scope, 'session');
  assert.equal(telemetry.evidence({ scope: 'record' }).samples.length, 1);
  assert.equal(telemetry.evidence({ scope: 'record' }).scope, 'recording');
});

test('record scope falls back to session when nothing was recorded', () => {
  const telemetry = new Telemetry();
  telemetry.link = { connected: true, ssid: 'Enso' };
  telemetry.history.traffic = [
    { t: 1000, rx: 10, tx: 1 },
    { t: 2000, rx: 20, tx: 2 },
  ];
  const evidence = telemetry.evidence({ scope: 'record' });
  assert.equal(evidence.scope, 'session');
  assert.equal(evidence.samples.length, 2);
});
