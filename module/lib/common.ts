export type Message = {
  type: string,
  body: any,
  metadata: {
    id?: number,
    sent: number
  }
};

export type Connection = {
  on: (
    event: "data" | "open" | "close" | "error",
    callback: (data?: any) => void
  ) => void;
  close: () => void
  send: (data: any) => void

  connectionId: string
  label: string
  metadata: any
  peer: string

  bufferSize: number
  open: boolean
  type: string
}

export const Peer = (window as any).Peer;

export const pathPattern = /^.+?((?=\/)|$)/;
export const subPathPattern = /\/(.+)/;

export type PromiseData = {
  data: any;
  resolve: (data: any) => void;
  reject: (data: any) => void;
}

export class Variable {
  readonly name: string;
  private value: any;
  readonly mode: "active" | "lazy";
  private onChange: (newVal: any) => Promise<boolean>;
  readonly user: string;

  // these values used for determining when variable should be updated
  private lastUpdate: number = 0;
  private lastUpdater: string = "";

  constructor(
    name: string,
    value: any,
    mode: "active" | "lazy",
    user: string,
    onChange: (newVal: any) => Promise<boolean>
  ) {
    this.name = name;
    this.value = value;
    this.mode = mode;

    this.user = user;

    this.onChange = onChange;
  }

  get() { return this.value; }
  private _set(value: any) {
    const oldValue = this.value;
    this._setPrivateValue(value);
    return this.onChange(oldValue);
  }
  set(
    value: any,
    from: string = this.user,
    time: number = (new Date()).getTime(),
    triggerCallback: boolean = true
  ) {
    if (
      this.lastUpdate < time // next update later
      || (this.lastUpdate == time && this.lastUpdater < from) // updates sent at the same time, use updater as tie-breaker
    ) {
      this.lastUpdate = time;
      this.lastUpdater = from;

      if (triggerCallback) this._set(value);
      else this._setPrivateValue(value);
      return true;
    }
    return false;
  }

  // update value without sending onchange event
  private _setPrivateValue(value: any) {
    this.value = value;
  }
}