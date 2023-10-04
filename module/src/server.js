import { Peer, pathPattern, subPathPattern, Variable } from "./common.js";
export class Server {
    peer;
    _id;
    initialized = false;
    conns = new Map;
    connectionCount = 0;
    postListeners = new Map;
    connectListeners = [];
    disconnectListeners = [];
    initListeners = [];
    varListeners = [];
    heartbeatPeriod;
    password;
    globalVars = new Map(); // variables that persist across all clients and the server
    constructor({ peerHost, peerId, password = "", connectTimeout = 1000, heartbeatPeriod = 1000 }) {
        const id = `${peerHost}_${peerId}`;
        this.peer = new Peer(id);
        this.heartbeatPeriod = heartbeatPeriod;
        this.password = password;
        // timeout in case connection doesn't make in time
        const connectTimeoutId = setTimeout(() => {
            this.initListeners.forEach(callback => { callback(null); }); // id of null implies server failed to start
            this.initialized = true; // prevent open after failing
        }, connectTimeout);
        // wait for peer to connect
        this.peer.on("open", (id) => {
            if (this.initialized) { // even if connection established, too slow
                this.peer.destroy();
                return;
            }
            clearTimeout(connectTimeoutId); // connection established, ignore timeout
            this.initialized = true;
            this._id = id;
            this.initListeners.forEach(callback => { callback(id); }); // id of null implies server failed to start
        });
        this.peer.on("connection", (conn) => {
            this.conns.set(conn.peer, {
                conn,
                hb: (new Date()).getTime(),
                init: false
            });
            this.initializeConnection(conn.peer);
        });
        setInterval(this.trimHeartless.bind(this), heartbeatPeriod * 2);
    }
    initializeConnection(connId) {
        const conn = this.conns.get(connId);
        const connRaw = conn.conn;
        connRaw.on("data", (data) => {
            const type = data.type.match(pathPattern)[0];
            // the only messages an uninitialized client can send are for init and disconnect
            if (!conn.init && type != "init" && type != "disconnect")
                return;
            switch (type) {
                case "init":
                    if (data.body == this.password) {
                        conn.init = true;
                        this.respondTo(connId, data.metadata.id, 200, {
                            "vars": {
                                "active": this.getActiveVarData(),
                                "lazy": this.getLazyVarData()
                            }
                        });
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
                    const subPath = data.type.match(subPathPattern)[0].replace("/", "");
                    if (this.postListeners.has(subPath)) {
                        const req = {
                            path: subPath,
                            body: data.body,
                            message: data
                        };
                        const res = {
                            send: this.respondTo.bind(this, connId, data.metadata.id, 200),
                            sendStatus: this.respondTo.bind(this, connId, data.metadata.id)
                        };
                        const callback = this.postListeners.get(subPath);
                        if (!callback(req, res)) {
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
                case "var": // server acts as be all/end all for if variable is changed
                    this.getVariable(data.body.name).set(data.body.value, data.body.from, data.body.time, true);
                    break;
            }
            // set heartbeat
            conn.hb = (new Date()).getTime();
        });
    }
    getActiveVarData() {
        const data = {};
        for (const [name, value] of this.globalVars.entries()) {
            if (value.mode == "lazy") {
                continue;
            } // ignore all lazy variables
            data[name] = {
                value: value.get()
            };
        }
        return data;
    }
    getLazyVarData() {
        const arr = [];
        for (const [name, value] of this.globalVars.entries()) {
            if (value.mode == "active") {
                continue;
            } // ignore all active variables
            arr.push(name);
        }
        return arr;
    }
    sendToAll(type, body) {
        for (const id of this.conns.keys()) {
            this.sendTo(id, type, body);
        }
    }
    sendTo(connId, type, body) {
        const message = {
            type,
            body,
            metadata: {
                sent: (new Date()).getTime()
            }
        };
        this.conns.get(connId).conn.send(message);
    }
    respondTo(connId, packetId, status, body) {
        this.sendTo(connId, `response/${packetId}`, {
            body,
            status
        });
    }
    trimHeartless() {
        const minAge = (new Date()).getTime() - this.heartbeatPeriod * 3;
        for (const [id, raw] of this.conns.entries()) {
            if (raw.hb < minAge) {
                this.closeConnection(id);
            }
        }
    }
    closeConnection(id) {
        this.conns.get(id).conn.close();
        this.conns.delete(id);
        this.connectionCount--;
        this.disconnectListeners.forEach(callback => { callback(id); });
    }
    get id() { return this._id; }
    get connections() { return this.connectionCount; }
    on(eventType, callback) {
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
                this.peer.on("error", callback);
                break;
            case "init":
                this.initListeners.push(callback);
                break;
            case "variable":
                this.varListeners.push(callback);
                break;
        }
    }
    // return type: will (eventually) do response -- if false: auto-response will be triggered
    post(channel, callback) {
        this.postListeners.set(channel, callback);
    }
    // peers will receive this, then send their own disconnect messages--allowing the server to then close the connection
    disconnect() {
        this.sendToAll("disconnect", true);
    }
    getVariable(name) {
        if (!this.globalVars.has(name)) { // if variable doesn't already exist: make that variable
            this.createVariable(name, null); // undefined is the default value for uninitialized variables
        }
        return this.globalVars.get(name);
    }
    createVariable(name, value, mode = "active") {
        if (this.globalVars.has(name)) {
            this.globalVars.get(name).set(// change value of existing variable
            value, "");
        }
        else { // create new variable
            this.globalVars.set(name, new Variable(name, value, mode, this.peer._id, this.onVariableChange.bind(this, mode, name)));
            this.onVariableChange(mode, name, value);
        }
    }
    onVariableChange(mode, name, value) {
        if (mode == "lazy")
            return; // don't bother updating a lazy variable
        const variable = this.globalVars.get(name);
        const body = {
            name,
            value
        };
        this.sendToAll("var", body);
        this.varListeners.forEach(callback => { callback(variable); });
    }
}
//# sourceMappingURL=server.js.map