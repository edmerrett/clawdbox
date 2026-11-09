/**
 * Minimal typings for the optional `bluetooth-serial-port` dependency (Bluetooth
 * Classic, used for the original Timebox Evo). Declared here so the project
 * type-checks and builds even where the native module is not installed (CI,
 * machines without a Bluetooth stack). Only the members we call are declared.
 */
declare module 'bluetooth-serial-port' {
  import { EventEmitter } from 'node:events';

  export class BluetoothSerialPort extends EventEmitter {
    constructor();
    inquire(): void;
    findSerialPortChannel(address: string, successCallback: (channel: number) => void, errorCallback?: () => void): void;
    connect(address: string, channel: number, successCallback: () => void, errorCallback?: (err?: Error) => void): void;
    write(buffer: Buffer, cb: (err?: Error) => void): void;
    close(): void;
    isOpen(): boolean;
    listPairedDevices(cb: (devices: { name: string; address: string; services?: { name?: string; channel: number }[] }[]) => void): void;
  }
}
