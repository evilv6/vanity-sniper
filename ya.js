// published by v6
"use strict";

const http2 = require("http2");
const WebSocket = require("ws");
const fs = require("fs");

const TOKEN = "token";
const GUILD = "sw id";
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const SP = 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6ImVuLVVTIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MiLCJvc192ZXJzaW9uIjoiIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzQ1Njc4fQ==';
const DISCORD_IPS = ['162.159.137.232', '162.159.135.232', '162.159.128.233', '162.159.136.232', '162.159.138.232'];
const REQUEST_COUNT = 4;

const B_PING = Buffer.from('{"op":1,"d":null}');
const B_GUILD_UPDATE = Buffer.from('"GUILD_UPDATE"');
const B_OP10 = Buffer.from('"op":10');
const B_READY = Buffer.from('"t":"READY"');
const B_OP7 = Buffer.from('"op":7');

let mfaToken = "";
const guilds = {};
let ws;
let heartbeatTimer;
let currentIpIndex = 0;
let client = null;
let lastLogTime = 0;

// Pre-computed HTTP/2 request headers template
const BASE_HEADERS = {
    ":method": "PATCH",
    ":path": `/api/v9/guilds/${GUILD}/vanity-url`,
    ":authority": "discord.com",
    "authorization": TOKEN,
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-super-properties": SP,
    "content-length": "0" // Will be updated
};

// Pre-computed JSON body buffer
let jsonBodyBuffer = null;
let jsonBodyLength = 0;

function updateJsonBody(code) {
    const jsonStr = JSON.stringify({ code: code });
    jsonBodyBuffer = Buffer.from(jsonStr);
    jsonBodyLength = jsonBodyBuffer.length;
    BASE_HEADERS["content-length"] = String(jsonBodyLength);
}

// Pre-compute initial body
updateJsonBody("");

function connectClient() {
    const ip = DISCORD_IPS[currentIpIndex];
    currentIpIndex = (currentIpIndex + 1) % DISCORD_IPS.length;

    const client = http2.connect(`https://discord.com`, {
        host: ip,
        servername: 'discord.com',
        settings: {
            maxConcurrentStreams: 1000,
            initialWindowSize: 65535 * 10,
            headerTableSize: 65536,
            maxHeaderListSize: 65536
        }
    });

    client.on("connect", (session, socket) => {
        if (socket && typeof socket.setNoDelay === 'function') {
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 1000);
        }
        connectWebSocket();
    });

    client.on("error", () => {
        setTimeout(() => connectClient(), 3000);
    });

    client.on("close", () => {
        setTimeout(() => connectClient(), 3000);
    });

    return client;
}

function sendPatchRequest(code) {
    // Update body with new code
    updateJsonBody(code);

    // Clone headers for this request batch
    const headers = Object.assign({}, BASE_HEADERS);

    for (let i = 0; i < REQUEST_COUNT; i++) {
        const ipIndex = i % DISCORD_IPS.length;
        const ip = DISCORD_IPS[ipIndex];
        headers[":authority"] = "discord.com";

        if (mfaToken) {
            headers["x-discord-mfa-authorization"] = mfaToken;
        }

        const req = client.request(headers);
        let statusCode = 0;
        let responseData = Buffer.alloc(0);

        req.on("response", (headers) => {
            statusCode = headers[":status"];
        });

        req.on("data", (chunk) => {
            responseData = Buffer.concat([responseData, chunk]);
        });

        req.on("end", () => {
            if (statusCode === 200) {
                const now = Date.now();
                if (now - lastLogTime > 1000) {
                    console.log("[PATCH] 200 OK");
                    lastLogTime = now;
                }
            }
        });

        req.on("error", () => {});
        req.write(jsonBodyBuffer);
        req.end();
    }
}

function connectWebSocket() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    ws = new WebSocket("wss://gateway.discord.gg/");

    ws.onopen = () => {};

    ws.onclose = () => {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        setTimeout(() => connectWebSocket(), 3000);
    };

    ws.onerror = () => {};

    ws.onmessage = (message) => {
        try {
            const data = JSON.parse(message.data);
            const { d, op, t } = data;

            if (t === "GUILD_UPDATE") {
                const existing = guilds[d.guild_id];
                if (existing && existing !== d.vanity_url_code) {
                    sendPatchRequest(existing);
                }
                return;
            }

            if (t === "READY") {
                d.guilds.forEach(({ id, vanity_url_code }) => {
                    if (vanity_url_code) {
                        guilds[id] = vanity_url_code;
                    }
                });
                return;
            }

            if (op === 10) {
                ws.send(JSON.stringify({
                    op: 2,
                    d: {
                        token: TOKEN,
                        intents: 1 << 0,
                        properties: {
                            os: "linux",
                            browser: "firefox",
                            device: "1337",
                        },
                    },
                }));

                if (!heartbeatTimer) {
                    heartbeatTimer = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ op: 1, d: {} }));
                        }
                    }, d.heartbeat_interval * (0.85 + 0.3));
                }
                return;
            }

            if (op === 7) {
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }
                ws.close();
                return;
            }
        } catch (err) {}
    };
}

setInterval(() => {
    if (!client || client.destroyed) {
        client = connectClient();
    }
    const req = client.request({
        ":method": "HEAD",
        ":path": "/api/users/@me",
        ":authority": "discord.com",
        authorization: TOKEN,
    });
    req.end();
}, 3000);

const loadMfaToken = () => {
    fs.readFile("mfa.txt", "utf8", (err, data) => {
        if (!err) {
            mfaToken = data.trim();
            console.log("[MFA] OK");
        } else {
            console.log("[MFA] NO");
        }
    });
};
loadMfaToken();
fs.watch("mfa.txt", () => loadMfaToken());

client = connectClient();
