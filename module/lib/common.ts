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

export abstract class Variable {
  readonly name: string;
  protected value: any;
  readonly user: string;
  
  protected onChange: (newVal: any) => Promise<boolean>;
  // private updateValue: () => Promise<any>;

  // these values used for determining when variable should be updated
  protected lastUpdate: number = 0;
  protected lastUpdater: string = "";

  constructor(
    name: string,
    value: any,
    user: string,
    onChange: (newVal: any) => Promise<boolean>
  ) {
    this.name = name;
    this.value = value;
    this.user = user;

    this.onChange = onChange;
  }

  abstract get(): Promise<any> | any;
  abstract set(
    value: any,
    from: string,
    time: number,
    triggerCallback: boolean
  ): boolean;
}

export class ActiveVariable extends Variable {
  constructor(
    name: string,
    value: any,
    user: string,
    onChange: (newVal: any) => Promise<boolean>
  ) {
    super(name,value,user,onChange);
  }

  get() { return this.value; }

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

  private _set(value: any) {
    const oldValue = this.value;
    this._setPrivateValue(value);
    this.onChange(oldValue);
  }

  private _setPrivateValue(value: any) {
    this.value = value;
  }
}

export class LazyVariable extends Variable {
  private onGet: () => Promise<any>;

  constructor(
    name: string,
    value: string,
    user: string,
    onChange: (newVal: any) => Promise<boolean>,
    onGet: () => Promise<any>
  ) {
    super(name,value,user,onChange);
    this.onGet = onGet;
  }

  get() { return this.onGet(); }
  getLocal() { return this.value; }

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

  private _set(value: any) {
    const oldValue = this.value;
    this._setPrivateValue(value);
    this.onChange(oldValue);
  }

  private _setPrivateValue(value: any) {
    this.value = value;
  }
}