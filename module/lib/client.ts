import { Peer, Connection, pathPattern, subPathPattern, PromiseData, Message, Variable, ActiveVariable, LazyVariable } from "./common.js"

export interface ClientInterface {
  peerHost: string
  peerId: string
  password?: string
  connectTimeout?: number
  heartbeatPeriod?: number
}

export class Client {
  private readonly peer: any;
  private connId: string;
  private conn: Connection;
  private _id: string;
  private initialized: boolean = false;
  private sendQueue: Message[] = [];

  private heartbeatDelta: number = 0;
  private readonly heartbeatPeriod: number;

  // these used for keeping track of responses
  private availableMessageIds: Set<number> = new Set<number>();
  private maxMessageId: number = 0;

  private timeoutId: number;
  private isConnectionDead: boolean = false;

  private messagePromises: Map<number, PromiseData> = new Map<number, PromiseData>();

  private readonly connectListeners: Array<(id: string) => void> = [];
  private readonly reconnectListeners: Array<(id: string) => void> = [];
  private readonly disconnectListeners: Array<(id: string) => void> = [];
  private readonly initListeners: Array<(id: string) => void> = [];
  private readonly errListeners: Array<(err:any) => void> = [];
  private readonly varListeners: Array<(variable: Variable) => void> = [];
  private readonly socketListeners: Array<(message: string) => void> = [];

  private readonly globalVars = {
    "active": new Map<string, ActiveVariable>(), // variables that persist across all clients and the server--immediately available to user and server
    "lazy": new Map<string, LazyVariable>(), // variables that persist across all clients and the server--requestable by user
  };

  private readonly password: string;

  public disconnectReason = "";

  constructor({
    peerHost,
    peerId,
    password = "",
    connectTimeout = 1000,
    heartbeatPeriod = 1000
  }: ClientInterface) {
    this.connId = `${peerHost}_${peerId}`
    this.peer = new Peer();
    this.heartbeatPeriod = heartbeatPeriod;
    this.password = password;

    // wait for peer to connect
    this.peer.on("open", (id: string) => {
      if (this.initialized) { // even if connection established, too slow
        this.peer.destroy();
        return;
      }

      this._id = id;
      this.initListeners.forEach(callback => { callback(id); }); // id of null implies server failed to start

      this.reconnect();
      this.on("reconnect", () => {
        // finish hanging promises
        for (const key of this.messagePromises.keys()) {
          const data = this.messagePromises.get(key).data;
          if (data.type == "hb") { // ignore heartbeat
            this.messagePromises.delete(key);
          }
          else {
            this.resend(data); // resend data that was never confirmed received
          }
        }

        // push hanging processes into send queue

        // reset message ids
        // this.availableMessageIds.clear();
        // this.maxMessageId = 0;

        if (this.isConnectionDead) return;
        this.reconnect();
        this.timeoutTimeout(connectTimeout);
      });
    });

    this.peer.on("error", (err: any) => { this.errListeners.forEach(callback => { callback(err); }) });
  }

  private timeoutTimeout(timeout: number) {
    this.timeoutId = setTimeout(() => {
      if (!this.initialized) {
        this.initialized = true;
        this.isConnectionDead = true;
        this.disconnectReason = "timeout";
        this.disconnectListeners.forEach(callback => { callback(this.conn.peer); });
      }
    }, timeout);
  }

  reconnect() {
    this.initialized = false;
    this.heartbeatDelta = 0;
    this.isConnectionDead = false;

    this.conn = this.peer.connect(this.connId);
    if (!this.conn) {
      this.isConnectionDead = true;
      this.disconnectReason = "server does not exist";
      this.disconnectListeners.forEach(callback => { callback(this.conn.peer); });
      return;
    }

    this.conn.on("open", () => {
      if (this.isConnectionDead) { // connection is dead, get rid of connection
        this.conn.close();
      }

      this.initialized = true;
      this.send("init", this.password).then(this.doInit.bind(this));
      this.emptySendQueue();

      const hbInterval = setInterval(() => {
        if (this.heartbeatDelta >= 3) { // assume disconnect
          this.initialized = false; // not initialized, so no messages can be sent
          clearInterval(hbInterval);
          
          if (!this.isConnectionDead) this.reconnectListeners.forEach(callback => { callback(this.conn.peer); });
          return;
        }

        this.heartbeatDelta++; // heartbeat sent, not yet received
        this.sendHeartbeat().then(() => {
          this.heartbeatDelta--; // heartbeat received/responded to
        });
      }, this.heartbeatPeriod);

      this.connectListeners.forEach(callback => { callback(this.conn.peer); });

      this.conn.on("data", (data: Message) => {
        const type = data.type.match(pathPattern)[0];
        clearTimeout(this.timeoutId);
        switch (type) {
          case "response": {
            const responseId = +data.type.match(subPathPattern)[0].replace("/","");
            this.releaseId(responseId);
            if (this.messagePromises.has(responseId)) {
              this.messagePromises.get(responseId).resolve({
                body: data.body.body,
                status: data.body.status,
                message: data
              });
              this.messagePromises.delete(responseId);
            }
            break;
          }
          case "disconnect": // server sending client request to disconnect
            clearInterval(hbInterval);
            this.isConnectionDead = true;
            this.disconnectReason = data.body;
            this.disconnectListeners.forEach(callback => { callback(this.conn.peer); });
            this.send("disconnect", true);
            break;
          case "var": {
            const variable = this.getActiveVariable(data.body.name); // this type of message only interacts with active vars
            
            // only send update if change
            if (variable.get() != data.body.value) {
              variable.set(
                data.body.value,
                data.body.from,
                data.body.time,
                false
              );
              this.varListeners.forEach(callback => { callback(variable); });
            }
            break;
          }
          case "socket": // a message sent from the server to the client, without expecting a response
            this.socketListeners.forEach(callback => { callback(data.body); });
            break;
        }
      });
    });
  }

  private doInit(response: Message) {
    const activeVars = response.body.vars.active;
    const lazyVars = response.body.vars.lazy;
    
    for (const name in activeVars) {
      const variable = new ActiveVariable(
        name,
        activeVars[name].value,
        this.peer._id,
        this.onVariableChange.bind(this, "active", name)
      );
      
      this.globalVars.active.set(
        name,
        variable
      );
      this.varListeners.forEach(callback => { callback(variable); });
    }

    for (const name of lazyVars) {
      const variable = new LazyVariable(
        name,
        null,
        this.peer._id,
        this.onVariableChange.bind(this, "lazy", name),
        this.onLazyVariableGet.bind(this, name)
      );
      
      this.globalVars.lazy.set(
        name,
        variable
      );
      this.varListeners.forEach(callback => { callback(variable); });
    }
  }

  private onVariableChange(
    mode: "active" | "lazy",
    name: string,
    oldValue: string
  ) {
    const variable = this.globalVars[mode].get(name);
    const value = (mode == "active") ? variable.get() : (variable as LazyVariable).getLocal();
    const body = {
      name,
      mode,
      action: "set",
      value,
      from: this.peer._id,
      time: (new Date()).getTime() // used to ensure everyone is working with the same data
    }
    this.send("var", body);

    // only send if value is different
    if (value != oldValue) { this.varListeners.forEach(callback => { callback(variable); }); }
  }

  private onLazyVariableGet(name: string): Promise<any> {
    const body = {
      name,
      mode: "lazy",
      action: "get"
    };

    return new Promise<any>((resolve) => {
      this.send("var", body).then((data) => {
        resolve(data.body);
      });
    });
  }

  private send(type: string, body: any) {
    const id = this.getNextAvailableId();

    const message: Message = {
      type,
      body,
      metadata: {
        id: id,
        sent: (new Date()).getTime()
      }
    };
    if (this.initialized) this.conn.send(message);
    else this.sendQueue.push(message);

    return new Promise<any>((resolve, reject) => {
      this.messagePromises.set(
        id,
        {
          data: message,
          resolve,
          reject
        }
      );
    });
  }
  private resend(message: Message) {
    if (this.initialized) this.conn.send(message);
    else this.sendQueue.push(message);    
  }

  private emptySendQueue() {
    if (!this.initialized) return;
    this.sendQueue.forEach((message) => {
      this.conn.send(message);
    });
  }

  private getNextAvailableId() {
    const itterator = this.availableMessageIds.values();
    const next = itterator.next();
    if (next.done) { // generate new id, to be added to pool later
      return this.maxMessageId++;
    }
    else { // return id, and remove from pool
      this.availableMessageIds.delete(next.value);
      return next.value;
    }
  }
  private releaseId(id: number) { // id no longer in use, add back to pool
    this.availableMessageIds.add(id);
  }

  private sendHeartbeat() {
    return this.send("hb", true);
  }

  getActiveVarData() {
    const data = {};
    for (const [name,value] of this.globalVars.active.entries()) { // loop through actives
      data[name] = {
        value: value.get()
      };
    }
    return data;
  }

  getLazyVarData() {
    const arr = [];
    for (const [name,value] of this.globalVars.active.entries()) { // loop through lazies
      arr.push(name);
    }
    return arr;
  }

  getActiveVariable(name: string): ActiveVariable {
    if (!this.globalVars.active.has(name)) { // if variable doesn't already exist: make that variable
      this.createActiveVariable(name, null); // undefined is the default value for uninitialized variables
    }
    return this.globalVars.active.get(name);
  }

  getLazyVariable(name: string): LazyVariable {
    if (!this.globalVars.lazy.has(name)) { // if variable doesn't already exist: make that variable
      this.createLazyVariable(name, null); // undefined is the default value for uninitialized variables
    }
    return this.globalVars.lazy.get(name);
  }

  createActiveVariable(
    name: string,
    value: any
  ) {
    if (this.globalVars.active.has(name)) {
      this.globalVars.active.get(name).set(value);
    }
    else { // create new variable
      this.globalVars.active.set(
        name,
        new ActiveVariable(
          name,
          value,
          this.peer._id,
          this.onVariableChange.bind(this, "active", name)
        )
      );
    }
  }

  createLazyVariable(
    name: string,
    value: any
  ) {
    if (this.globalVars.lazy.has(name)) {
      this.globalVars.lazy.get(name).set(value);
    }
    else { // create new variable
      this.globalVars.lazy.set(
        name,
        new LazyVariable(
          name,
          value,
          this.peer._id,
          this.onVariableChange.bind(this, "lazy", name),
          this.onLazyVariableGet.bind(this, name)
        )
      );
    }
  }

  post(path: string, data: any) {
    return this.send(
      `post/${path}`,
      data
    );
  }

  disconnect() {
    this.send("disconnect-req", true);
    this.isConnectionDead = true;
  }

  on(
    eventType: "connect" | "reconnect" | "disconnect" | "error" | "init" | "variable" | "socket",
    callback: (data: any) => void
  ) {
    switch (eventType) {
      // triggered when client connects to server
      case "connect":
        this.connectListeners.push(callback);
        break;
      case "reconnect":
        this.reconnectListeners.push(callback);
      // // triggered when client disconnects from server
      case "disconnect":
        this.disconnectListeners.push(callback);
        break;
      // triggered when this peer experiences an error
      case "error":
        this.errListeners.push(callback);
        break;
      case "init":
        this.initListeners.push(callback);
        break;
      case "variable":
        this.varListeners.push(callback);
        break;
      case "socket":
        this.socketListeners.push(callback);
        break;
    }
  }

  off(
    eventType: "connect" | "reconnect" | "disconnect" | "error" | "init" | "variable" | "socket",
    callback: (data: any) => void
  ) {
    let arr: Array<(data: any) => void> = [];
    switch (eventType) {
      case "connect":
        arr = this.connectListeners;
        break;
      case "reconnect":
        arr = this.reconnectListeners;
        break;
      case "disconnect":
        arr = this.disconnectListeners;
        break;
      case "error":
        arr = this.errListeners;
        break;
      case "init":
        arr = this.initListeners;
        break;
      case "variable":
        arr = this.varListeners;
        break;
      case "socket":
        arr = this.socketListeners;
        break;
    }
    for (let i in arr) {
      if (arr[i] == callback) {
        arr.splice(+i,1);
        break;
      }
    }
  }
}