var config = require('./config');
var irc = require('irc');
var req = require('request');
var moment = require('moment');

var bot = {
    url_geocode: "https://maps.googleapis.com/maps/api/geocode/json?sensor=false&key={APIKEY}&latlng=",
    url_hmt_vehicle: "http://habhub.org/mt/?filter=",
    storage: {
        hysplit: {
            timestamp: 0,
            data: null
        },
        tracker: {
            timestamp: 0,
            data: null
        }
    },
    color: {
        SBJ:'magenta',
        EXT:'light_blue',
        URL:'dark_blue'
    },

    client: null,

    init: function(config) {
        if(!config) return;

        this.config = config;

        // set api key
        this.url_geocode = this.url_geocode.replace("{APIKEY}", config.google_api_key);

        // init client
        this.client = new irc.Client(config.server, config.nick, config);
        var command_regex = /^\!([a-z]+) ?(.*)?$/;

        // handle commands
        var ctx = this;

        this.client.addListener('message', function (from, to, message) {
            if(to[0] != "#") return;

            var match = message.match(command_regex);

            if(match && match.length) {
                var cmd = match[1];
                var args = (match[2] === undefined) ? "" : match[2];
                var opts = {
                        "cmd": cmd,
                        "from": from,
                        "args": args,
                        "channel": to
                };

                switch(cmd) {
                    case "hysplit": ctx.handle_hysplit(opts); break;
                    case "track": ctx.handle_track(opts); break;

                    case "tracker": ctx.respond(to, from, [
                                            "Here you go -",
                                            [ctx.color.URL, "http://habhub.org/mt/"]
                                        ]); break;

                    case "wiki": ctx.respond(to, from, [
                                         "Here you go -",
                                         [ctx.color.URL, "http://ukhas.org.uk"]
                                     ]); break;

                    case "ping": ctx.handle_ping(opts); break;
                    case "whereis": ctx.handle_whereis(opts); break;

                    default: break;
                }

            }
        });

        // additional handlers
        this.client.addListener('join', function(chan, nick, msg) {
            if(nick.indexOf(ctx.config.nick) == 0) ctx.init_fetch();
        });

        this.client.addListener('error', function(message) {
                console.log('error: ', message);
        });
    },

    init_fetch_complete: false,

    init_fetch: function () {
        if(this.init_fetch_complete) return;
        this.init_fetch_complete = true;

        // fetch latest positions from the tracker
        this.fetch_latest_positions();
    },

    fetch_latest_positions: function() {
        var ctx = this;

        req("http://spacenear.us/tracker/datanew.php?mode=latest&type=positions&format=json&max_positions=0&position_id=0", function(error, response, body) {
            if (!error && response.statusCode == 200) {
                ctx.storage.tracker.timestamp = (new Date()).getTime();
                var data = JSON.parse(body).positions.position;

                var obj = {};
                for(var k in data) {
                    var name = data[k].vehicle.toLowerCase();

                    obj[name] = data[k];
                    obj[name]['gps_time'] = new Date(obj[name]['gps_time'] + "Z");
                    obj[name]['server_time'] = new Date(obj[name]['server_time'] + "Z");

                    if(ctx.storage.tracker.data) {
                        if(!(name in ctx.storage.tracker.data)) {
                            ctx.notify(["New vehicle on the map:", [ctx.color.SBJ, name], "-", [ctx.color.URL, ctx.url_hmt_vehicle + name]]);
                        } else if(ctx.storage.tracker.data[name].gps_time.getTime() + 21600000 < obj[name].gps_time.getTime())  {
                            ctx.notify(["New position from", [ctx.color.SBJ, name], "after", [ctx.color.SBJ, moment(ctx.storage.tracker.data[name].gps_time).fromNow(true)], "silence", "-", [ctx.color.URL, ctx.url_hmt_vehicle + name]]);
                        }
                    }
                }
                ctx.storage.tracker.data = obj;
            }
            else {
                console.log(error);
            }

            setTimeout(function() { ctx.fetch_latest_positions() }, 5000);
        });
    },

    // wrapper function for nice looking reponses

    respond: function(dest, to, msg) {
        var resp = (to) ? irc.colors.wrap(this.color.SBJ, to) + ": " : "";

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
        this.client.say(dest, resp);
    },

    // notify

    notify: function(msg) {
        for(var k in config.channels) {
            respond(config.channels[k], null, msg);
        }
    },

    // util

    ts: function(text) {
        return (new Date(text)).getTime();
    },

    format_number: function(num, decimal_places) {
            return Math.floor(num * Math.pow(10, decimal_places)) / Math.pow(10,decimal_places);
    },

    // handle hysplit

    handle_hysplit: function(options) {
        if(this.storage.hysplit.timestamp + 30000 > (new Date()).getTime()) {
                    this.reply_hysplit(options);
        }
        else {
            var ctx = this;

            req('http://spacenear.us/tracker/datanew.php?type=hysplit&format=json', function (error, response, body) {
                if (!error && response.statusCode == 200) {
                    ctx.storage.hysplit.timestamp = (new Date()).getTime();
                    ctx.storage.hysplit.data = JSON.parse(body);

                    for(var k in ctx.storage.hysplit.data) ctx.storage.hysplit.data[k.toLowerCase()] = ctx.storage.hysplit.data[k];

                    ctx.reply_hysplit(options);
                }
            })
        }
    },

    reply_hysplit: function(opts) {
        if(opts.args in this.storage.hysplit.data) {
            this.respond(opts.channel, opts.from, [
                    "HYSPLIT for",
                    [this.color.SBJ, opts.args],
                    '-',
                    [this.color.URL, this.storage.hysplit.data[opts.args].url_gif]
                    ]);
        }
        else {
            this.respond(opts.channel, opts.from, "No HYSPLIT for that callsign");
        }
    },

    // handle pong

    handle_ping: function(opts) {
        if(this.storage.tracker.data && opts.args.toLowerCase() in this.storage.tracker.data) {
            var timestamp = this.storage.tracker.data[opts.args.toLowerCase()].gps_time;

            this.respond(opts.channel, opts.from, ["Last contact was", [this.color.SBJ, moment(timestamp).fromNow()]]);
        }
        else {
            this.respond(opts.channel, opts.from, ["No contact from", [this.color.SBJ, opts.args]]);
        }
    },

    handle_whereis: function(opts) {
        if(this.storage.tracker.data && opts.args.toLowerCase() in this.storage.tracker.data) {
            var name = opts.args.toLowerCase();
            var lat = this.format_number(this.storage.tracker.data[name].gps_lat, 5);
            var lng = this.format_number(this.storage.tracker.data[name].gps_lon, 5);
            var alt = this.format_number(this.storage.tracker.data[name].gps_alt, 0);
            var ctx = this;

            req(this.url_geocode + lat + ',' + lng, function(error, response, body) {
                if (!error && response.statusCode == 200) {
                    var data = JSON.parse(body);
                    if(data.results.length) {
                        var address = data.results[0].formatted_address;
                        ctx.respond(opts.channel, opts.from, [(alt>1000)?"Over":"Near", [ctx.color.SBJ, address], [ctx.color.EXT, '('+lat+','+lng+')'], "at", [ctx.color.SBJ, alt + " meters"]]);
                    }
                    return;
                }

                ctx.respond(opts.channel, opts.from, [(alt>1000)?"Over":"Near", [ctx.color.SBJ, lat+','+lng], "at", [ctx.color.SBJ, alt + " meters"]]);
            });


        }
        else {
            this.respond(opts.channel, opts.from, "I haven't got a clue");
        }
    },

    handle_track: function(opts) {
        var url = this.url_hmt_vehicle + opts.args.split(/[, ;]/).filter(function(val) { return val != "";}).join(";")
        this.respond(opts.channel, opts.from, ["Here you go -", [this.color.URL, url]]);
    }
}

module.exports = bot;

if(module.parent == null) bot.init(config);
