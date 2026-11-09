// A stand-in for bridge/clawdbox_ble.py used by ble-display.test.ts.
// Speaks the same JSON-lines protocol. Behaviour is steered by env vars:
//   FAKE_FAIL_FIRST=1  -> the first "anim" op answers with an error
//   FAKE_SLOW_CONNECT=ms -> delay before "connected"
import { createInterface } from 'node:readline';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
emit({ ev: 'ready', mode: 'fake' });
emit({ ev: 'error', message: 'connect failed: simulated; retry in 2s' }); // status, not a reply
let failed = false;
setTimeout(() => emit({ ev: 'connected', address: 'fake-uuid' }), Number(process.env.FAKE_SLOW_CONNECT ?? 50));
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.op === 'anim') {
    if (process.env.FAKE_FAIL_FIRST && !failed) {
      failed = true;
      emit({ ev: 'error', id: m.id, re: 'anim', message: 'anim failed: simulated' });
      return;
    }
    emit({ ev: 'shown', id: m.id, re: 'anim', name: m.name, mode: 'fake', frames: m.frames.length });
  } else if (m.op === 'brightness') emit({ ev: 'brightness', id: m.id, re: 'brightness', value: m.value });
  else if (m.op === 'ping') emit({ ev: 'pong', id: m.id, re: 'ping' });
  else emit({ ev: 'error', id: m.id, re: m.op, message: `unknown op ${m.op}` });
});
process.on('SIGTERM', () => process.exit(0));
