const $ = document.querySelector.bind(document);

import { Server } from "./module/src/server.js";
import { Client } from "./module/src/client.js";

$("#send-submit").addEventListener("click", () => { sendData(); });
$("#send-data").addEventListener("keydown", (e) => {
  if (e.key == "Enter") { sendData(); }
})

function setData(txt) {
  $("#recv").innerHTML = txt;
}

function setRaw(obj) {
  $("#raw-data").innerHTML = "";
  $("#raw-data").append(setRawComponent(obj));
}

const colorDepth = ["#ffa3a3","#ffca68","#eded85","#94eb94","#9a9aff","#e371e3"];
function setRawComponent(obj, depth=0) {
  const el = document.createElement("div");
  el.style.backgroundColor = colorDepth[depth % colorDepth.length];

  if (typeof obj == "string") {
    el.classList.add("json-raws", "json-strings", "json-primitives");
    el.innerText = `\"${obj}\"`;
  }
  else if (typeof obj == "number") {
    el.classList.add("json-raws", "json-numbers", "json-primitives");
    el.innerText = obj;
  }
  else if (typeof obj == "boolean") {
    el.classList.add("json-raws", "json-bools", "json-primitives");
    el.innerText = obj;
  }
  else if (obj === undefined || obj === null) {
    el.classList.add("json-raws", "json-undefineds", "json-primitives");
    el.innerText = obj;
  }
  else if (Array.isArray(obj)) {
    el.classList.add("json-raws", "json-arrays");
    for (const value of obj) { el.append(setRawComponent(value, depth+1)); }
  }
  else { // assume typeof object
    el.classList.add("json-raws", "json-objects");
    for (const key in obj) {
      const keyEl = setRawComponent(key, depth);
      const value = setRawComponent(obj[key], depth+1)
      const keyValPair = document.createElement("div");
      keyValPair.classList.add("json-raws", "json-key-value-pairs");
      keyValPair.append(keyEl, ": ", value);
      el.append(keyValPair);
    }
  }

  return el;
}

var sendData = () => {};

if (location.search == "") {
  const server = new Server({
    peerHost: "test",
    peerId: "0001",
    password: "abcd"
  })
  
  server.post("test", (req,res) => {
    setData(req.body);
    setRaw(req);
    res.send(req.body);
  })

  server.on("connect", (id) => {
    console.log(`connected to: ${id}`);
  })
  server.on("disconnect", (id) => {
    console.log(`disconnected from: ${id}`);
  })

  server.on("connect", () => {
    $("#connections").innerText = server.connections;
  })
  server.on("disconnect", () => {
    $("#connections").innerText = server.connections;
  })

  $("#disconnect").addEventListener("click", () => {
    server.disconnect();
  });

  server.on("variable", (variable) => {
    const vals = server.getActiveVarData();
    $("#var-values").innerText = "";
    for (const value in vals) {
      $("#var-values").innerText += `${value}: ${vals[value].value}\n`;
    }
  })

  $("#var-set").addEventListener("click", () => {
    const name = $("#var-name").value;
    const value = $("#var-value").value;
    server.getVariable(name).set(value);
  });

  server.getVariable("test");
}
else {
  const client = new Client ({
    peerHost: "test",
    peerId: "0001",
    password: "abcd"
  })

  sendData = () => {
    const data = $("#send-data").value;
    client.post(location.search.replace("?",""), data).then((data) => {
      setData(data.body);
      setRaw(data);
    });
  }

  client.on("connect", (id) => {
    console.log("connected to", id)
  })
  client.on("disconnect", (id) => {
    console.log("disconnected from", id, "because:", client.disconnectReason);
  })
  client.on("init", id => {
    $("#connections").innerText = id;
  })

  $("#disconnect").addEventListener("click", () => {
    client.disconnect();
  });

  client.on("variable", (variable) => {
    const vals = client.getActiveVarData();
    $("#var-values").innerText = "";
    for (const value in vals) {
      $("#var-values").innerText += `${value}: ${vals[value].value}\n`;
    }
  })

  $("#var-set").addEventListener("click", () => {
    const name = $("#var-name").value;
    const value = $("#var-value").value;
    client.getVariable(name).set(value);
  });

  const offset = Math.floor(Math.random() * 100) / 100;

  setInterval(() => {
    client.getVariable("ms").set(Math.floor((new Date).getTime() / 100) * 100 + offset);
  }, 100);

  // console.log(client.on("error", (err) => { console.log(err) }))
}