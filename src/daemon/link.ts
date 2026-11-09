/**
 * Transport to the Evo. `RfcommLink` uses bluetooth-serial-port (Bluetooth Classic
 * SPP, works on macOS via IOBluetooth and on Linux via BlueZ). `MockLink` logs.
 */
import { EventEmitter } from 'node:events';

export interface Link extends EventEmitter {
  connect(): Promise<void>;
  write(buf: Buffer): Promise<void>;
  close(): void;
  readonly open: boolean;
  readonly label: string;
}

export class MockLink extends EventEmitter implements Link {
  open = false;
  readonly label = 'mock';
  bytes = 0;
  messages = 0;
  constructor(private readonly verbose = false) {
    super();
  }
  async connect(): Promise<void> {
    this.open = true;
  }
  async write(buf: Buffer): Promise<void> {
    if (!this.open) throw new Error('mock link closed');
    this.bytes += buf.length;
    this.messages++;
    if (this.verbose) console.log(`[mock] ${buf.length} bytes: ${buf.subarray(0, 8).toString('hex')}...`);
  }
  close(): void {
    this.open = false;
    this.emit('closed');
  }
}

export interface BtService {
  name?: string;
  channel: number;
}
export interface BtPairedDevice {
  name: string;
  address: string;
  services?: BtService[];
}

interface BtSerial extends EventEmitter {
  listPairedDevices(cb: (devices: BtPairedDevice[]) => void): void;
  findSerialPortChannel(address: string, ok: (channel: number) => void, fail?: () => void): void;
  connect(address: string, channel: number, ok: () => void, fail?: (err?: Error) => void): void;
  write(buffer: Buffer, cb: (err?: Error) => void): void;
  close(): void;
  isOpen(): boolean;
}

/** Compare Bluetooth addresses regardless of case and separator ("-" on macOS, ":" elsewhere). */
export function sameAddress(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^0-9a-f]/g, '');
  return norm(a) === norm(b);
}

/**
 * Pick the Serial Port Profile channel from a device's SDP service list.
 * The Evo advertises several RFCOMM services (hands-free for calls, SPP for
 * commands). The JieLi chip names its serial service "JL_SPP".
 */
export function pickSppChannel(services: BtService[]): number | undefined {
  const named = services.find((s) => s.channel > 0 && /spp|serial/i.test(s.name ?? ''));
  return named?.channel;
}

export class RfcommLink extends EventEmitter implements Link {
  private port: BtSerial | null = null;
  open = false;
  readonly label: string;
  /** Channel actually used by the last successful connect. */
  channelUsed?: number;

  constructor(
    private readonly address: string,
    private readonly channel?: number,
    private readonly connectTimeoutMs = 15_000,
    private readonly log: (m: string) => void = () => {},
  ) {
    super();
    this.label = `rfcomm ${address}`;
  }

  async connect(): Promise<void> {
    let mod: { BluetoothSerialPort: new () => BtSerial };
    try {
      mod = (await import('bluetooth-serial-port')) as unknown as { BluetoothSerialPort: new () => BtSerial };
    } catch (e) {
      throw new Error(
        `bluetooth-serial-port is not installed or failed to build (${(e as Error).message}). ` +
          `Run "npm install" on the machine with the Bluetooth adapter (macOS needs Xcode command line tools).`,
      );
    }
    const port = new mod.BluetoothSerialPort();
    this.port = port;
    const channel = this.channel ?? (await this.findChannel(port));
    this.channelUsed = channel;
    this.log(`opening RFCOMM channel ${channel}${this.channel === undefined ? ' (auto)' : ''}`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`connect to ${this.address} ch ${channel} timed out`)), this.connectTimeoutMs);
      port.connect(
        this.address,
        channel,
        () => {
          clearTimeout(t);
          resolve();
        },
        (err) => {
          clearTimeout(t);
          reject(err ?? new Error(`cannot connect to ${this.address} channel ${channel}`));
        },
      );
    });
    this.open = true;
    port.on('closed', () => {
      this.open = false;
      this.emit('closed');
    });
    port.on('failure', (err: Error) => {
      this.open = false;
      this.emit('closed', err);
    });
    port.on('data', (buf: Buffer) => this.emit('data', buf));
  }

  /** List the SDP services of this device as the OS has them cached. */
  services(port: BtSerial): Promise<BtService[]> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve([]), 5000);
      try {
        port.listPairedDevices((devices) => {
          clearTimeout(t);
          const d = devices.find((x) => sameAddress(x.address, this.address));
          resolve(d?.services ?? []);
        });
      } catch {
        clearTimeout(t);
        resolve([]);
      }
    });
  }

  /**
   * Prefer the service literally named SPP/serial. The library's own
   * findSerialPortChannel matches the generic RFCOMM UUID and can return the
   * hands-free channel instead, which accepts bytes and ignores them.
   */
  private async findChannel(port: BtSerial): Promise<number> {
    const services = await this.services(port);
    if (services.length) this.log(`services: ${services.map((s) => `${s.name ?? '?'}=${s.channel}`).join(', ')}`);
    const spp = pickSppChannel(services);
    if (spp) return spp;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(1), 8000);
      port.findSerialPortChannel(
        this.address,
        (ch) => {
          clearTimeout(t);
          this.log(`no service named SPP; library suggests channel ${ch}`);
          resolve(ch);
        },
        () => {
          clearTimeout(t);
          resolve(1);
        },
      );
    });
  }

  write(buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.open) return reject(new Error('link not open'));
      this.port.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): void {
    try {
      this.port?.close();
    } catch {
      /* ignore */
    }
    this.open = false;
  }
}
