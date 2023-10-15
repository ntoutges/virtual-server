import { Peer, Connection, pathPattern, subPathPattern, Message, Variable, LazyVariable, ActiveVariable } from "./common.js"

type ConnType = {
  hb: number
  conn: Connection,
  init: boolean
};

export type Request = {
  path: string
  body: any
  message: Message,
  from: string
}
export type Response = {
  send: (data: any) => void;
  sendStatus: (status: number, data: any) => void
}

export interface ServerInterface {
  peerHost: string
  peerId: string
  password?: string
  connectTimeout?: number
  heartbeatPeriod?: number
}

export class Server {
  private readonly peer: any;
  private _id: string;
  private initialized: boolean = false;
  private conns: Map<string, ConnType> = new Map<string, ConnType>;

  private connectionCount: number = 0;

  private readonly postListeners: Map<string, (req: Request, res: Response) => boolean> = new Map<string, (req: Request, res: Response) => boolean>;
  private readonly connectListeners: Array<(id: string) => void> = [];
  private readonly disconnectListeners: Array<(id: string) => void> = [];
  private readonly initListeners: Array<(id: string) => void> = [];
  private readonly errListeners: Array<(err:any) => void> = [];
  private readonly varListeners: Array<(variable: Variable) => void> = [];
  
  readonly heartbeatPeriod: number;
  readonly password: string;

  // private readonly globalVars: Map<string, ActiveVariable> = new Map<string, ActiveVariable>(); // variables that persist across all clients and the server
  // private readonly globalVarCategorization: {
  //   "active": Set<string>,
  //   "lazy": Set<string>,
  //   "all": Map<string, "active" | "lazy"> // used for reverse search
  // } = {
  //   "active": new Set<string>(),
  //   "lazy": new Set<string>(),
  //   "all": new Map<string, "active" | "lazy">()
  // };

  private readonly globalVars = {
    "active": new Map<string, ActiveVariable>(), // variables that persist across all clients and the server--immediately available to user and server
    "lazy": new Map<string, LazyVariable>(), // variables that persist across all clients and the server--requestable by user
  }

  constructor({
    peerHost,
    peerId,
    password = "",
    connectTimeout = 1000,
    heartbeatPeriod = 1000
  }: ServerInterface) {
    const id = `${peerHost}_${peerId}`
    this.peer = new Peer(id);

    this.heartbeatPeriod = heartbeatPeriod;
    this.password = password;

    // timeout in case connection doesn't make in time
    const connectTimeoutId = setTimeout(() => {
      this.initListeners.forEach(callback => { callback(null); }); // id of null implies server failed to start
      this.initialized = true; // prevent open after failing
    }, connectTimeout);
    
    // wait for peer to connect
    this.peer.on("open", (id: string) => {
      if (this.initialized) { // even if connection established, too slow
        this.peer.destroy();
        return;
      }

      clearTimeout(connectTimeoutId); // connection established, ignore timeout
      this.initialized = true;
      this._id = id;
      this.initListeners.forEach(callback => { callback(id); }); // id of null implies server failed to start
    });

    this.peer.on("connection", (conn: Connection) => {
      this.conns.set(
        conn.peer,
        {
          conn,
          hb: (new Date()).getTime(),
          init: false
        }
      );
      this.initializeConnection(conn.peer);
    });

    this.peer.on("error", (err: any) => { this.errListeners.forEach(callback => { callback(err); }) });

    setInterval(this.trimHeartless.bind(this), heartbeatPeriod * 2);
  }

  private initializeConnection(connId: string) {
    const conn = this.conns.get(connId);
    const connRaw = conn.conn;
    connRaw.on("data", (data: Message) => {
      
      const type = data.type.match(pathPattern)[0];
      
      // the only messages an uninitialized client can send are for init and disconnect
      if (!conn.init && type != "init" && type != "disconnect") return;
      
      switch (type) {
        case "init":
          if (data.body == this.password) {
            conn.init = true;
            this.respondTo(
              connId,
              data.metadata.id,
              200,
              {
                "vars": {
                  "active": this.getActiveVarData(),
                  "lazy": this.getLazyVarData()
                }
              }
            );
            
            this.connectionCount++;
            this.connectListeners.forEach(callback => { callback(connId); });
          }
          else { // incorrect password
            this.sendTo(connId, "disconnect", "password"); // reason for disconnect is password
          }
          break;
        case "hb":
          conn.hb = data.body;
          this.respondTo(connId, data.metadata.id, 200, true);
          break;
        case "post": {
          const subPath = data.type.match(subPathPattern)[0].replace("/","");
          if (this.postListeners.has(subPath)) {
            const req: Request = {
              path: subPath,
              body: data.body,
              message: data,
              from: connId
            };
            const res: Response = {
              send: this.respondTo.bind(this, connId, data.metadata.id, 200),
              sendStatus: this.respondTo.bind(this, connId, data.metadata.id)
            };

            const callback = this.postListeners.get(subPath);
            if (!callback(req,res)) {
              // do autoresponse
              this.respondTo(connId, data.metadata.id, 200, true);
            }
          }
          else { // auto-respond to prevent bad things
            this.respondTo(connId, data.metadata.id, 404, true); // stealing HTTP status codes
          }
          break;
        }
        case "disconnect-req": // client sending intent to disconnect from server
          this.sendTo(connId, "disconnect", "disconnect"); // reason for disconnect is disconnection
          break;
        case "disconnect": // client sending confirmation of disconnect to server
          connRaw.close();
          this.closeConnection(connId);
          break;
        case "var": { // server acts as be all/end all for if variable is changed
          const mode = data.body.mode as "active" | "lazy";
          const action = data.body.action as "set" | "read";
          
          if (action == "set") {
            ((mode == "active") ? this.getActiveVariable(data.body.name) : this.getLazyVariable(data.body.name)).set(
              data.body.value,
              data.body.from,
              data.body.time,
              true
            );
            this.respondTo(connId, data.metadata.id, 200, true);
          }
          else { // action == "read"
            if (mode == "active") {
              this.respondTo(
                connId, data.metadata.id, 200,
                this.getActiveVariable(data.body.name).get()
              );
            }
            else {
              this.getLazyVariable(data.body.name).get().then(value => {
                this.respondTo(connId, data.metadata.id, 200, value);
              });
            }
          }
        }
        break;
      }
      // set heartbeat
      conn.hb = (new Date()).getTime();
    });
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

  // connId of "*" sends to all (broadcast, effectively)
  sendSocket(connId: string, body: any) {
    if (connId == "*") {
      this.sendToAll(
        "socket",
        body
      );
    }
    else {
      this.sendTo(
        connId,
        "socket",
        body
      );
    }
  }

  private sendToAll(type: string, body: any) {
    for (const id of this.conns.keys()) { this.sendTo(id, type, body); }
  }
  private sendTo(connId: string, type: string, body: any) {
    const message: Message = {
      type,
      body,
      metadata: {
        sent: (new Date()).getTime()
      }
    }
    this.conns.get(connId).conn.send(message);
  }
  private respondTo(connId: string, packetId: number, status: number, body: any) {
    this.sendTo(connId, `response/${packetId}`, {
      body,
      status
    });
  }

  private trimHeartless() {
    const minAge = (new Date()).getTime() - this.heartbeatPeriod*3;
    for (const [id, raw] of this.conns.entries()) {
      if (raw.hb < minAge) { this.closeConnection(id); }
    }
  }

  private closeConnection(id: string) {
    this.conns.get(id).conn.close();
    this.conns.delete(id);
    this.connectionCount--;
    this.disconnectListeners.forEach(callback => { callback(id); });
  }

  get id() { return this._id; }
  get connections() { return this.connectionCount; }
  on(
    eventType: "connect" | "disconnect" | "error" | "post" | "init" | "variable",
    callback: (data: any) => void
  ) {
    switch (eventType) {
      // triggered when client connects to server
      case "connect":
        this.connectListeners.push(callback);
        break;
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
    }
  }
  off(
    eventType: "connect" | "disconnect" | "error" | "post" | "init" | "variable",
    callback: (data: any) => void
  ) {
    let arr: Array<(data: any) => void> = [];
    switch (eventType) {
      case "connect":
        arr = this.connectListeners;
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
    }
    for (let i in arr) {
      if (arr[i] == callback) {
        arr.splice(+i,1);
        break;
      }
    }
  }
  
  // return type: will (eventually) do response -- if false: auto-response will be triggered
  post(channel: string, callback: (req: Request, res: Response) => boolean) {
    this.postListeners.set(channel, callback);
  }

  unpost(channel: string) {
    this.postListeners.delete(channel);
  }

  // peers will receive this, then send their own disconnect messages--allowing the server to then close the connection
  disconnect() {
    this.sendToAll("disconnect", true);
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

  private onVariableChange(
    mode: "active" | "lazy",
    name: string,
    oldValue: string
  ) {
    if (mode == "lazy") return; // don't bother updating a lazy variable

    const variable = this.globalVars.active.get(name);
    const body = {
      name,
      value: variable.get()
    }
    this.sendToAll("var", body); // update all, even if variable is unchanged, because client may have different value
    
    // only send update to local listeners if there *is* a difference
    if (variable.get() != oldValue) {
      this.varListeners.forEach(callback => { callback(variable); });
    }
  }

  // server is the authority on lazy variable values, therefore it can just return itself
  private onLazyVariableGet(name: string): Promise<any> {
    return new Promise(resolve => {
      resolve(this.globalVars.lazy.get(name).getLocal());
    });
  }
}