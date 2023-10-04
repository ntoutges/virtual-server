export const Peer = window.Peer;
export const pathPattern = /^.+?((?=\/)|$)/;
export const subPathPattern = /\/(.+)/;
export class Variable {
    name;
    value;
    mode;
    onChange;
    user;
    // these values used for determining when variable should be updated
    lastUpdate = 0;
    lastUpdater = "";
    constructor(name, value, mode, user, onChange) {
        this.name = name;
        this.value = value;
        this.mode = mode;
        this.user = user;
        this.onChange = onChange;
    }
    get() { return this.value; }
    _set(value) {
        this._setPrivateValue(value);
        return this.onChange(value);
    }
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
    // update value without sending onchange event
    _setPrivateValue(value) {
        this.value = value;
    }
}
//# sourceMappingURL=common.js.map