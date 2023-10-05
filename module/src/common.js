export const Peer = window.Peer;
export const pathPattern = /^.+?((?=\/)|$)/;
export const subPathPattern = /\/(.+)/;
export class Variable {
    name;
    value;
    user;
    onChange;
    // private updateValue: () => Promise<any>;
    // these values used for determining when variable should be updated
    lastUpdate = 0;
    lastUpdater = "";
    constructor(name, value, user, onChange) {
        this.name = name;
        this.value = value;
        this.user = user;
        this.onChange = onChange;
    }
}
export class ActiveVariable extends Variable {
    constructor(name, value, user, onChange) {
        super(name, value, user, onChange);
    }
    get() { return this.value; }
    set(value, from = this.user, time = (new Date()).getTime(), triggerCallback = true) {
        if (this.lastUpdate < time // next update later
            || (this.lastUpdate == time && this.lastUpdater < from) // updates sent at the same time, use updater as tie-breaker
        ) {
            this.lastUpdate = time;
            this.lastUpdater = from;
            if (triggerCallback)
                this._set(value);
            else
                this._setPrivateValue(value);
            return true;
        }
        return false;
    }
    _set(value) {
        const oldValue = this.value;
        this._setPrivateValue(value);
        this.onChange(oldValue);
    }
    _setPrivateValue(value) {
        this.value = value;
    }
}
export class LazyVariable extends Variable {
    onGet;
    constructor(name, value, user, onChange, onGet) {
        super(name, value, user, onChange);
        this.onGet = onGet;
    }
    get() { return this.onGet(); }
    getLocal() { return this.value; }
    set(value, from = this.user, time = (new Date()).getTime(), triggerCallback = true) {
        if (this.lastUpdate < time // next update later
            || (this.lastUpdate == time && this.lastUpdater < from) // updates sent at the same time, use updater as tie-breaker
        ) {
            this.lastUpdate = time;
            this.lastUpdater = from;
            if (triggerCallback)
                this._set(value);
            else
                this._setPrivateValue(value);
            return true;
        }
        return false;
    }
    _set(value) {
        const oldValue = this.value;
        this._setPrivateValue(value);
        this.onChange(oldValue);
    }
    _setPrivateValue(value) {
        this.value = value;
    }
}
//# sourceMappingURL=common.js.map