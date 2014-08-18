var config = require('./config');
var irc = require('irc');
var req = require('request');
var moment = require('moment');

var storage = {
    hysplit: {
        timestamp: 0,
        data: null
    },
    tracker: {
        timestamp: 0,
        data: null
    }
};
var init_complete = false;

COLOR_SBJ = 'yellow';
COLOR_URL = 'dark_blue';

function init() {
    console.log("INIT");
    if(init_complete) return;
    init_complete = true;

    // fetch latest positions from the tracker
    fetch_latest_positions();
}

function fetch_latest_positions() {
req("http://spacenear.us/tracker/datanew.php?mode=latest&type=positions&format=json&max_positions=0&position_id=0", function(error, response, body) {
    if (!error && response.statusCode == 200) {
        storage.tracker.timestamp = (new Date()).getTime();
        var data = JSON.parse(body).positions.position;

        var obj = {};
        for(var k in data) {
            var name = data[k].vehicle;

            obj[name] = data[k];
            obj[name]['gps_time'] = new Date(obj[name]['gps_time'] + "Z");
            obj[name]['server_time'] = new Date(obj[name]['server_time'] + "Z");

            if(storage.tracker.data) {
                if(!(name in storage.tracker.data)) {
                    notify(["New vehicle on the map:", [COLOR_SBJ, name]]);
                } else if(storage.tracker.data[name].gps_time.getTime() + 43200000 < obj[name].gps_time.getTime())  {
                    notify(["New position from", [COLOR_SBJ, name], "after", [COLOR_SBJ, moment(storage.tracker.data[name].gps_time).fromNow(true)], "silence."]);
                }
            }
        }
        storage.tracker.data = obj;
    }
    else {
        console.log(error);
    }

    setTimeout(fetch_latest_positions, 30000);
});
}

var bot = new irc.Client(config.server, config.nick, config);
var command_regex = /^\!([a-z]+) ?(.*)?$/;

// handle commands
bot.addListener('message', function (from, to, message) {
    var match = message.match(command_regex);

    if(match && match.length) {
        var cmd = match[1];
        var args = (match[2] === undefined) ? "" : match[2];

        switch(cmd) {
            case "hysplit": handle_hysplit({
                "cmd": cmd,
                "from": from,
                "args": args,
                "channel": to
            }); break;

            case "tracker": respond(to, from, [
                                    "Here you go -",
                                    [COLOR_URL, "http://habhub.org/mt/"]
                                ]); break;

            case "wiki": respond(to, from, [
                                 "Here you go -",
                                 [COLOR_URL, "http://wiki.ukhas.org.uk"]
                             ]); break;

            case "ping": handle_ping({
                "cmd": cmd,
                "from": from,
                "args": args,
                "channel": to
            }); break;

            case "whereis": handle_whereis({
                "cmd": cmd,
                "from": from,
                "args": args,
                "channel": to
            }); break;

            default: break;
        }

    }
});

bot.addListener('join', function(chan, nick, msg ) {
    if(nick == config.nick) init();
});

bot.addListener('error', function(message) {
        console.log('error: ', message);
});

// wrapper function for nice looking reponses

function respond(dest, to, msg) {
    var resp = (to) ? irc.colors.wrap("yellow", to) + ": " : "";

    if(typeof msg == 'string') {
        resp += msg;
    } else {
        for(var k in msg) {
            if(typeof msg[k] == 'string') {
                resp += msg[k] + ' ';
            } else {
                resp += irc.colors.wrap(msg[k][0], msg[k][1]) + ' ';
            }
        }
    }
    bot.say(dest, resp);
}

// notify

function notify(msg) {
    for(var k in config.channels) {
        respond(config.channels[k], null, msg);
    }
}

// handle hysplit

function handle_hysplit(options) {
    if(storage.hysplit.timestamp + 30000 > (new Date()).getTime()) {
                reply_hysplit(options);
    }
    else {
        req('http://spacenear.us/tracker/datanew.php?type=hysplit&format=json', function (error, response, body) {
            if (!error && response.statusCode == 200) {
                storage.hysplit.timestamp = (new Date()).getTime();
                storage.hysplit.data = JSON.parse(body);

                reply_hysplit(options);
            }
        })
    }
};

function reply_hysplit(opts) {
    if(opts.args in storage.hysplit.data) {
        respond(opts.channel, opts.from, [
                "HYSPLIT for",
                [COLOR_SBJ, opts.args],
                '-',
                [COLOR_URL, storage.hysplit.data[opts.args].url_gif]
                ]);
    }
    else {
        respond(opts.channel, opts.from, "No HYSPLIT for that callsign.");
    }
}

// handle pong

function handle_ping(opts) {
    if(storage.tracker.data && opts.args in storage.tracker.data) {
        var timestamp = storage.tracker.data[opts.args].gps_time;

        respond(opts.channel, opts.from, ["Last contact was", [COLOR_SBJ, moment(timestamp).fromNow()]]);
    }
    else {
        respond(opts.channel, opts.from, ["No contact from", [COLOR_SBJ, opts.args]]);
    }
};

function handle_whereis(opts) {
    if(storage.tracker.data && opts.args in storage.tracker.data) {
        var lat = storage.tracker.data[opts.args].gps_lat;
        var lng = storage.tracker.data[opts.args].gps_lon;
        var alt = storage.tracker.data[opts.args].gps_alt;

        respond(opts.channel, opts.from, ["Near", [COLOR_SBJ, lat+', '+lng], "at", [COLOR_SBJ, alt + " meters."]]);
    }
    else {
        respond(opts.channel, opts.from, "I haven't got a clue");
    }
};
