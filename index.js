const mqtt = require('mqtt')
const fs = require('fs');
const { ToadScheduler, SimpleIntervalJob, Task } = require('toad-scheduler');
const { Watchdog } = require("watchdog");
const { exit } = require('process');

const client  = mqtt.connect('**REDACTED**', {
    username: "**REDACTED**",
    password: "**REDACTED**"
});

const scheduler = new ToadScheduler();
let chunkSize = 9950;

let config = {
    "20E7F8": {
        schedule: [
            {
                path: "/Users/aiden/pixlet/examples/bitcoin.webp",
                name: "bitcoin",
                duration: 60
            },
            {
                path: "/Users/aiden/pixlet/examples/bitcoin.webp",
                name: "bitcoin2",
                duration: 60
            }
        ],
        currentApplet: -1,
        currentAppletStartedAt: 0,
        connected: false,
        sendingStatus: {
            timed_out: false,
            retries: 0,
            currentBufferPos: 0,
            buf: null,
            hasSentLength: false,
            isCurrentlySending: false
        },
        jobRunning: false,
        offlineWatchdog: null
    }
};

function deviceLoop(device) {
    if(config[device].jobRunning || config[device].connected == false) {
        return;
    }

    config[device].jobRunning = true;
    client.publish(`plm/${device}/applet`, "PING");

    const nextAppletNeedsRunAt = config[device].currentAppletStartedAt + (config[device].schedule[config[device].currentApplet+1].duration * 1000);

    if(Date.now() > nextAppletNeedsRunAt && !config[device].sendingStatus.isCurrentlySending) {
        console.log("send next applet");
        config[device].currentApplet++;

        const applet = config[device].schedule[config[device].currentApplet];
        config[device].sendingStatus.isCurrentlySending = true;

        console.log(applet);
        
        let file = fs.readFileSync(applet.path);
        config[device].sendingStatus.buf = new Uint8Array(file);
        config[device].sendingStatus.currentBufferPos = 0;
        config[device].sendingStatus.hasSentLength = false;

        client.publish(`plm/${device}/applet`, "START");

        config[device].currentAppletStartedAt = Date.now();
        if(config[device].currentApplet >= (config[device].schedule.length - 1)) {
            config[device].currentApplet = -1;
        }
    }

    config[device].jobRunning = false;
}

function gotDeviceResponse(device, message) {
    config[device].offlineWatchdog.feed();
    console.log(device, message.toString());
    if(message == "OK") {
        if(config[device].sendingStatus.currentBufferPos <= config[device].sendingStatus.buf.length) {
            if(config[device].sendingStatus.hasSentLength == false) {
                config[device].sendingStatus.hasSentLength = true;
                client.publish(`plm/${device}/applet`, config[device].sendingStatus.buf.length.toString());
            } else {
                let chunk = config[device].sendingStatus.buf.slice(config[device].sendingStatus.currentBufferPos, config[device].sendingStatus.currentBufferPos+chunkSize);
                config[device].sendingStatus.currentBufferPos += chunkSize;
                client.publish(`plm/${device}/applet`, chunk);
            }
        } else {
            client.publish(`plm/${device}/applet`, "FINISH");
        }
    } else {
        if(message == "PUSHED") {
            console.log("message successfully pushed to device...");
            config[device].sendingStatus.isCurrentlySending = false;
        } else if(message == "DECODE_ERROR") {
            console.log("message unsuccessfully pushed to device...");
            config[device].sendingStatus.isCurrentlySending = false;
        } else if(message == "DEVICE_BOOT" || message == "PONG") {
            console.log("device is online!");
            config[device].connected = true;
        } else if(message == "TIMEOUT") {
            console.log("device rx timeout!");
            config[device].sendingStatus.isCurrentlySending = false;
        }
    }
}

client.on('connect', function () {
    for(const [device, _] of Object.entries(config)) {
        client.subscribe(`plm/${device}/applet/rts`, function (err) {
            if (!err) {
                client.publish(`plm/${device}/applet`, "PING");
                
                //Setup job to work on device.
                const task = new Task('simple task', () => {
                    deviceLoop(device)
                });
                
                const job = new SimpleIntervalJob(
                    { seconds: 5, runImmediately: true },
                    task,
                    { id: `loop_${device}` }
                );

                scheduler.addSimpleIntervalJob(job);

                const dog = new Watchdog(30000);
                dog.on('reset', () => {
                    console.log(`Device ${device} disconnected.`);
                    config[device].connected = false;
                })
                dog.on('feed',  () => {
                    config[device].connected = true;
                })

                config[device].offlineWatchdog = dog;
            } else {
                console.log(`Couldn't subscribe to ${device} response channel.`);
            }
        })
    }
});

client.on("disconnect", function() {
    scheduler.stop()
    exit(1);
});

client.on("error", function() {
    scheduler.stop()
    exit(1);
});

client.on("close", function() {
    scheduler.stop()
    exit(1);
});

client.on('message', function (topic, message) {
    if(topic.indexOf("rts") != -1) {
      const device = topic.split("/")[1];
      gotDeviceResponse(device, message);
    }
})