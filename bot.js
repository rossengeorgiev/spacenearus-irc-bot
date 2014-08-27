var config = require('./config');
var irc = require('irc');
var req = require('request');
var moment = require('moment');

moment.locale("en-gb");

var bot = {
    url_geocode: "https://maps.googleapis.com/maps/api/geocode/json?sensor=false&result_type=sublocality|administrative_area_level_2|administrative_area_level_1|country&result_type=sublocality&key={APIKEY}&latlng=",
    url_geocode_ocean: "http://api.geonames.org/oceanJSON?lat={LAT}&lng={LNG}&username={USER}",
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
        SBJ:'dark_green',
        EXT:'cyan',
        URL:'light_blue'
    },

    client: null,

    init: function(config) {
        if(!config) return;

        this.config = config;

        // set api key
        this.url_geocode = this.url_geocode.replace("{APIKEY}", config.google_api_key);
        this.url_geocode_ocean = this.url_geocode_ocean.replace("{USER}", config.geonames_api_user);

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


                    case "wiki": ctx.handle_wiki(opts); break;
                    case "ping": ctx.handle_ping(opts); break;
                    case "whereis": ctx.handle_whereis(opts); break;

                    case "flights": ctx.handle_flights(opts); break;
                    case "flight": ctx.handle_flight(opts); break;

                    case "payloads":
                    case "payload":
                    case "dial":
                                   ctx.handle_payloads(opts); break;

                    case "window": ctx.handle_window(opts); break;

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
                            ctx.notify([
                                "New vehicle on the map:",
                                [ctx.color.SBJ, obj[name].vehicle],
                                "-",
                                [ctx.color.URL, ctx.url_hmt_vehicle + obj[name].vehicle]
                            ]);
                        } else if(ctx.storage.tracker.data[name].gps_time.getTime() + 21600000 < obj[name].gps_time.getTime())  {
                            ctx.notify([
                                "New position from",
                                [ctx.color.SBJ, obj[name].vehicle],
                                "after",
                                [ctx.color.SBJ, moment(ctx.storage.tracker.data[name].gps_time).fromNow(true)],
                                "silence",
                                "-",
                                [ctx.color.URL, ctx.url_hmt_vehicle + obj[name].vehicle]
                            ]);
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
        for(var k in config.channels_notify) {
            this.respond(config.channels_notify[k], null, msg);
        }
    },

    // util

    ts: function(text) {
        return (new Date(text)).getTime();
    },

    format_number: function(num, decimal_places) {
            return Math.floor(num * Math.pow(10, decimal_places)) / Math.pow(10,decimal_places);
    },

    // reverse geocode
    //
    resolve_location: function(lat, lng, callback) {
        var ctx = this;

        req(this.url_geocode + lat + ',' + lng, function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var data = JSON.parse(body);

                if(data.results.length) {
                    callback(data.results[0].formatted_address);
                }
                // maybe position is over an ocean?
                else {
                    req(ctx.url_geocode_ocean.replace("{LAT}",lat).replace("{LNG}",lng), function(error, response, body) {
                        if (!error && response.statusCode == 200) {
                            var data = JSON.parse(body);

                            if("ocean" in data) {
                                callback(data.ocean.name);
                                return;
                            }
                        }
                        callback(null);
                    });
                }
                return;
            }

            callback(null);
        });
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
            var name = this.storage.tracker.data[opts.args.toLowerCase()].vehicle;

            this.respond(opts.channel, opts.from, ["Last contact with", [this.color.SBJ, name], "was", [this.color.SBJ, moment(timestamp).fromNow()]]);
        }
        else {
            this.respond(opts.channel, opts.from, ["No contact from", [this.color.SBJ, opts.args]]);
        }
    },

    handle_whereis: function(opts) {
        if(this.storage.tracker.data && opts.args.toLowerCase() in this.storage.tracker.data) {
            var callsignl = opts.args.toLowerCase();
            var callsign = this.storage.tracker.data[callsignl].vehicle;
            var lat = this.storage.tracker.data[callsignl].gps_lat;
            var lng = this.storage.tracker.data[callsignl].gps_lon;
            var alt = this.storage.tracker.data[callsignl].gps_alt;
            var dt_minutes = moment().diff(moment(this.storage.tracker.data[callsignl].gps_time), 'minutes');
            var ctx = this;

            this.resolve_location(lat,lng, function(name) {
                var msg = [[ctx.color.SBJ, callsign], (dt_minutes<=3)?"is":"was", (alt>1000)?"over":"near" ];

                if(name) {
                    msg.push([ctx.color.SBJ, name], [ctx.color.EXT, '('+lat+','+lng+')']);
                }
                else {
                    msg.push([ctx.color.SBJ, lat+','+lng]);
                }

                msg.push("at", [ctx.color.SBJ, ctx.format_number(alt,0) + " meters"]);
                ctx.respond(opts.channel, opts.from, msg);
            });

        }
        else {
            this.respond(opts.channel, opts.from, "I haven't got a clue");
        }
    },

    handle_wiki: function(opts) {
        var ctx = this;

        req("http://ukhas.org.uk/start?do=search&id="+opts.args, function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var match = body.match(/search_quickhits.*ul/g);
                if(match) {
                    match = match[0].match(/<a href="(.*?)".*?>(.*?)<\/a>/g);

                    if(match.length < 4) {
                        for(var k in match) {
                            submatch = match[k].match(/<a href="(.*?)".*?>(.*?)<\/a>/);
                            ctx.respond(opts.channel, opts.from, ["Wiki page", [ctx.color.SBJ, submatch[2]], "-", [ctx.color.URL, "http://ukhas.org.uk" + submatch[1]]]);
                        }
                    } else {
                        ctx.respond(opts.channel, opts.from, ["Found", [ctx.color.SBJ, match.length], "results for you query"]);
                    }
                } else {
                    ctx.respond(opts.channel, opts.from, "No results for your query");
                }
            } else {
                ctx.respond(opts.channel, opts.from, "Error occured while running your query");
            }
        });
    },

    handle_track: function(opts) {
        var url = this.url_hmt_vehicle + opts.args.split(/[, ;]/).filter(function(val) { return val != "";}).join(";")
        this.respond(opts.channel, opts.from, ["Here you go -", [this.color.URL, url]]);
    },


    // habitat stuff
    //
    handle_flights: function(opts) {
        var ctx = this;

        req("http://habitat.habhub.org/habitat/_design/flight/_view/end_start_including_payloads?include_docs=true&startkey=["+((new Date()).getTime()/1000)+"]", function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var data = JSON.parse(body);

                if(data.rows.length) {
                    var msg = ["Current flights:"];


                    for(var k in data.rows) {
                        var id_len = data.rows[k].id.length;
                        var id = data.rows[k].id.substr(id_len - 4);
                        var doc = data.rows[k].doc;

                        if(doc.type == "flight" && ctx.ts(doc.start) < (new Date()).getTime()) {
                            msg.push([ctx.color.SBJ, doc.name],[ctx.color.EXT, "("+id+"),"]);
                        }
                    }

                    // remove extra comma
                    var xref = msg[msg.length - 1];
                    xref[1] = xref[1].slice(0,-1);

                    ctx.respond(opts.channel, opts.from, msg);
                }
                else {
                    ctx.respond(opts.channel, opts.from, "There are no flights currently :(");
                }
            }

        });
    },

    handle_flight: function(opts) {
        var ctx = this;

        req("http://habitat.habhub.org/habitat/_design/flight/_view/end_start_including_payloads?include_docs=true&startkey=["+((new Date()).getTime()/1000)+"]", function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var data = JSON.parse(body);

                if(data.rows.length) {
                    var flight_id = null;

                    // if the argument is a callsign, try to find the payload_configuration for flight_id
                    for(var k in data.rows) {
                        var xref = data.rows[k];

                        if(xref.doc.type == "payload_configuration" && opts.args.toLowerCase() == xref.doc.name.toLowerCase()) {
                            flight_id = xref.id;
                            break;
                        }
                    }

                    for(var k in data.rows) {
                        var id_len = data.rows[k].id.length;
                        var id = data.rows[k].id;
                        var doc = data.rows[k].doc;

                        var match = (flight_id != null) ? id == flight_id : id.substr(id_len - 4) == opts.args;

                        if(doc.type == "flight" && ctx.ts(doc.start) < (new Date()).getTime() && match) {
                            var msg = ["Flight", [ctx.color.EXT, "(" + id.substr(id_len - 4) + "):"], [ctx.color.SBJ, doc.name]];
                            var lat = ctx.format_number(doc.launch.location.latitude, 5);
                            var lng = ctx.format_number(doc.launch.location.longitude, 5);

                            // number of payloads
                            msg.push([ctx.color.EXT, "("+doc.payloads.length+" payload"+(doc.payloads.length > 1 ? 's':'')+")"], "-");

                            // time
                            msg.push("Launch date", [ctx.color.SBJ, moment(new Date(doc.launch.time)).calendar()]),

                            // place
                            msg.push("from");

                            // try to reverse geocode the position
                            ctx.resolve_location(lat, lng, function(name) {
                                if(name) {
                                    msg.push([ctx.color.SBJ, name]);
                                }

                                msg.push([ctx.color.EXT, "("+lat+","+lng+")"]);

                                ctx.respond(opts.channel, opts.from, msg);
                            });

                            return;
                        }
                    }

                    ctx.respond(opts.channel, opts.from, "Can't find a flight doc matching your query");
                }
                else {
                    ctx.respond(opts.channel, opts.from, "There are no flights currently :(");
                }
            }

        });
    },

    handle_payloads: function(opts) {
        var ctx = this;

        req("http://habitat.habhub.org/habitat/_design/flight/_view/end_start_including_payloads?include_docs=true&startkey=["+((new Date()).getTime()/1000)+"]", function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var data = JSON.parse(body);

                if(data.rows.length) {
                    var found = false;

                    for(var k in data.rows) {
                        var id_len = data.rows[k].id.length;
                        var id = data.rows[k].id.substr(id_len - 4);
                        var doc = data.rows[k].doc;

                        if(doc.type == "payload_configuration" && (id == opts.args || doc.name.toLowerCase() == opts.args.toLowerCase())) {
                            found = true;

                            var msg = ["Payload",[ctx.color.SBJ, doc.name], [ctx.color.EXT, "("+id+")"],"-"];

                            if(doc.transmissions.length == 0) {
                                msg.push("no transmissions");
                            }
                            else {
                                xref = doc.transmissions[0];

                                msg.push([ctx.color.SBJ, (xref.frequency / 1000000) + " MHz " + xref.mode]);

                                switch(xref.modulation) {
                                    case "DominoEX":
                                        msg.push([ctx.color.SBJ, xref.modulation], "with speed", [ctx.color.SBJ, xref.speed]);
                                        break;
                                    case "Hellschreiber":
                                        msg.push([ctx.color.SBJ, xref.modulation + " " + xref.variant]);
                                        break;
                                    case "RTTY":
                                        msg.push([ctx.color.SBJ, xref.modulation + " " + xref.baud + "/" + xref.shift + "Hz " + xref.encoding + " " + xref.parity + " " + xref.stop]);
                                        break;
                                    default: break;

                                }
                            }


                            ctx.respond(opts.channel, opts.from, msg);
                        }
                    }

                    if(!found) ctx.respond(opts.channel, opts.from, "Can't find a flight doc matching your query");
                }
                else {
                    ctx.respond(opts.channel, opts.from, "There are no flights currently :(");
                }
            }

        });
    },

    handle_window: function(opts) {
        var ctx = this;

        req("http://habitat.habhub.org/habitat/_design/flight/_view/end_start_including_payloads?include_docs=true&startkey=["+((new Date()).getTime()/1000)+"]", function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var data = JSON.parse(body);

                if(data.rows.length) {
                    var flight_id = null;

                    // if the argument is a callsign, try to find the payload_configuration for flight_id
                    for(var k in data.rows) {
                        var xref = data.rows[k];

                        if(xref.doc.type == "payload_configuration" && opts.args.toLowerCase() == xref.doc.name.toLowerCase()) {
                            flight_id = xref.id;
                            break;
                        }
                    }

                    for(var k in data.rows) {
                        var id_len = data.rows[k].id.length;
                        var id = data.rows[k].id;
                        var doc = data.rows[k].doc;

                        var match = (flight_id != null) ? id == flight_id : id.substr(id_len - 4) == opts.args;

                        if(doc.type == "flight" && ctx.ts(doc.start) < (new Date()).getTime() && match) {
                            ctx.respond(opts.channel, opts.from, [
                                "Flight window for",
                                [ctx.color.SBJ, doc.name],
                                [ctx.color.EXT, "(" + id.substr(id_len - 4) + ")"],
                                "is from",
                                [ctx.color.SBJ, moment(new Date(doc.start)).calendar()],
                                "to",
                                [ctx.color.SBJ, moment(new Date(doc.end)).calendar()],
                            ]);

                            return;
                        }
                    }

                    ctx.respond(opts.channel, opts.from, "Can't find a flight doc matching your query");
                }
                else {
                    ctx.respond(opts.channel, opts.from, "There are no flights currently :(");
                }
            }

        });
    },
}

module.exports = bot;

if(module.parent == null) bot.init(config);
