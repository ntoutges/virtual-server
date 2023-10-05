import { Peer, pathPattern, subPathPattern, ActiveVariable, LazyVariable } from "./common.js";
export class Client {
    peer;
    connId;
    conn;
    _id;
    initialized = false;
    sendQueue = [];
    heartbeatDelta = 0;
    heartbeatPeriod;
    // these used for keeping track of responses
    availableMessageIds = new Set();
    maxMessageId = 0;
    timeoutId;
    isConnectionDead = false;
    messagePromises = new Map();
    connectListeners = [];
    reconnectListeners = [];
    disconnectListeners = [];
    initListeners = [];
    varListeners = [];
    globalVars = {
        "active": new Map(),
        "lazy": new Map(), // variables that persist across all clients and the server--requestable by user
    };
    password;
    disconnectReason = "";
    constructor({ peerHost, peerId, password = "", connectTimeout = 1000, heartbeatPeriod = 1000 }) {
        this.connId = `${peerHost}_${peerId}`;
        this.peer = new Peer();
        this.heartbeatPeriod = heartbeatPeriod;
        this.password = password;
        // wait for peer to connect
        this.peer.on("open", (id) => {
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
                if (this.isConnectionDead)
                    return;
                this.reconnect();
                this.timeoutTimeout(connectTimeout);
            });
        });
    }
    timeoutTimeout(timeout) {
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
                    if (!this.isConnectionDead)
                        this.reconnectListeners.forEach(callback => { callback(this.conn.peer); });
                    return;
                }
                this.heartbeatDelta++; // heartbeat sent, not yet received
                this.sendHeartbeat().then(() => {
                    this.heartbeatDelta--; // heartbeat received/responded to
                });
            }, this.heartbeatPeriod);
            this.connectListeners.forEach(callback => { callback(this.conn.peer); });
            this.conn.on("data", (data) => {
                const type = data.type.match(pathPattern)[0];
                clearTimeout(this.timeoutId);
                switch (type) {
                    case "response": {
                        const responseId = +data.type.match(subPathPattern)[0].replace("/", "");
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
                            variable.set(data.body.value, data.body.from, data.body.time, false);
                            this.varListeners.forEach(callback => { callback(variable); });
                        }
                        break;
                    }
                }
            });
        });
    }
    doInit(response) {
        const activeVars = response.body.vars.active;
        const lazyVars = response.body.vars.lazy;
        for (const name in activeVars) {
            const variable = new ActiveVariable(name, activeVars[name].value, this.peer._id, this.onVariableChange.bind(this, "active", name));
            this.globalVars.active.set(name, variable);
            this.varListeners.forEach(callback => { callback(variable); });
        }
        for (const name of lazyVars) {
            const variable = new LazyVariable(name, null, this.peer._id, this.onVariableChange.bind(this, "lazy", name), this.onLazyVariableGet.bind(this, name));
            this.globalVars.lazy.set(name, variable);
            this.varListeners.forEach(callback => { callback(variable); });
        }
    }
    onVariableChange(mode, name, oldValue) {
        const variable = this.globalVars[mode].get(name);
        const value = (mode == "active") ? variable.get() : variable.getLocal();
        const body = {
            name,
            mode,
            action: "set",
            value,
            from: this.peer._id,
            time: (new Date()).getTime() // used to ensure everyone is working with the same data
        };
        this.send("var", body);
        // only send if value is different
        if (value != oldValue) {
            this.varListeners.forEach(callback => { callback(variable); });
        }
    }
    onLazyVariableGet(name) {
        const body = {
            name,
            mode: "lazy",
            action: "get"
        };
        return new Promise((resolve) => {
            this.send("var", body).then((data) => {
                resolve(data.body);
            });
        });
    }
    send(type, body) {
        const id = this.getNextAvailableId();
        const message = {
            type,
            body,
            metadata: {
                id: id,
                sent: (new Date()).getTime()
            }
        };
        if (this.initialized)
            this.conn.send(message);
        else
            this.sendQueue.push(message);
        return new Promise((resolve, reject) => {
            this.messagePromises.set(id, {
                data: message,
                resolve,
                reject
            });
        });
    }
    resend(message) {
        if (this.initialized)
            this.conn.send(message);
        else
            this.sendQueue.push(message);
    }
    emptySendQueue() {
        if (!this.initialized)
            return;
        this.sendQueue.forEach((message) => {
            this.conn.send(message);
        });
    }
    getNextAvailableId() {
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
    releaseId(id) {
        this.availableMessageIds.add(id);
    }
    sendHeartbeat() {
        return this.send("hb", true);
    }
    getActiveVarData() {
        const data = {};
        for (const [name, value] of this.globalVars.active.entries()) { // loop through actives
            data[name] = {
                value: value.get()
            };
        }
        return data;
    }
    getLazyVarData() {
        const arr = [];
        for (const [name, value] of this.globalVars.active.entries()) { // loop through lazies
            arr.push(name);
        }
        return arr;
    }
    getActiveVariable(name) {
        if (!this.globalVars.active.has(name)) { // if variable doesn't already exist: make that variable
            this.createActiveVariable(name, null); // undefined is the default value for uninitialized variables
        }
        return this.globalVars.active.get(name);
    }
    getLazyVariable(name) {
        if (!this.globalVars.lazy.has(name)) { // if variable doesn't already exist: make that variable
            this.createLazyVariable(name, null); // undefined is the default value for uninitialized variables
        }
        return this.globalVars.lazy.get(name);
    }
    createActiveVariable(name, value) {
        if (this.globalVars.active.has(name)) {
            this.globalVars.active.get(name).set(value);
        }
        else { // create new variable
            this.globalVars.active.set(name, new ActiveVariable(name, value, this.peer._id, this.onVariableChange.bind(this, "active", name)));
        }
    }
    createLazyVariable(name, value) {
        if (this.globalVars.lazy.has(name)) {
            this.globalVars.lazy.get(name).set(value);
        }
        else { // create new variable
            this.globalVars.lazy.set(name, new LazyVariable(name, value, this.peer._id, this.onVariableChange.bind(this, "lazy", name), this.onLazyVariableGet.bind(this, name)));
        }
    }
    post(path, data) {
        return this.send(`post/${path}`, data);
    }
    disconnect() {
        this.send("disconnect-req", true);
        this.isConnectionDead = true;
    }
    on(eventType, callback) {
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
}
//# sourceMappingURL=client.js.map