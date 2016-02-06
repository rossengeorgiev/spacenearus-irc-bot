var config = require('./config');
var irc = require('irc');
var req = require('request');
var moment = require('moment');

moment.locale("en-gb");

var bot = {
    url_geocode: "https://maps.googleapis.com/maps/api/geocode/json?sensor=false&result_type=sublocality|administrative_area_level_2|administrative_area_level_1|country&result_type=sublocality&key={APIKEY}&latlng=",
    url_geocode_ocean: "http://api.geonames.org/oceanJSON?lat={LAT}&lng={LNG}&username={USER}",
    url_hmt_vehicle: "http://tracker.habhub.org/#!qm=All&q=",
    url_hmt_monocle: "http://habitat.habhub.org/monocle/?uri=",
    storage: {
        hysplit: {
            timestamp: 0,
            data: null,
            match: null
        },
        tracker: {
            timestamp: 0,
            data: null,
            latest_pos_id: 0
        },
        doclookup: {
            timestamp: 0,
            doc: null
        }
    },
    color: {
        SBJ:'dark_green',
        EXT:'cyan',
        URL:'light_blue'
    },

    regex_cmd: /^[\!\.]([0-9a-zA-Z]+) ?(.*)?$/,
    regex_docid: /([a-f0-9]{64}|[a-f0-9]{32})/gi,
    regex_reltime: /([0-9]+)([mhdw])/gi,

    client: null,
    crashed: false,
    snus_conn_problem: false,

    init: function(config) {
        if(!config) return;

        this.config = config;

        // set api key
        this.url_geocode = this.url_geocode.replace("{APIKEY}", config.google_api_key);
        this.url_geocode_ocean = this.url_geocode_ocean.replace("{USER}", config.geonames_api_user);

        // init client
        this.client = new irc.Client(config.server, config.nick, config);
        var regex_cmd = this.regex_cmd;
        var regex_docid = this.regex_docid;

        // handle commands
        var ctx = this;

        this.client.addListener('message', function (from, to, message) {
            if(to[0] != "#") return;

            var match = message.match(regex_cmd);

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
                    // regular commands
                    case "help": ctx.handle_help(opts, false); break;
                    case "8ball": ctx.handle_8ball(opts); break;
                    case "flip": ctx.handle_flip(opts); break;
                    case "aprs": ctx.handle_aprs(opts); break;
                    case "hysplit": ctx.handle_hysplit(opts); break;
                    case "track": ctx.handle_track(opts); break;

                    case "tracker": ctx.respond(to, from, [
                                            "Here you go -",
                                            [ctx.color.URL, "http://habhub.org/t/"]
                                        ]); break;


                    case "wiki": ctx.handle_wiki(opts); break;
                    case "ping": ctx.handle_ping(opts); break;

                    case "status":
                    case "whereis":
                                 ctx.handle_whereis(opts); break;

                    case "monocle": ctx.handle_monocle(opts); break;
                    case "id": ctx.handle_id(opts); break;
                    case "flights": ctx.handle_flights(opts); break;
                    case "flight": ctx.handle_flight(opts); break;

                    case "payloads":
                    case "payload":
                                   ctx.handle_payloads(opts); break;
                    case "dial":
                                   ctx.handle_dial(opts); break;

                    case "window": ctx.handle_window(opts); break;

                    default:
                        // admin commands
                        if(ctx.config.channel_admins && opts.channel == ctx.config.channel_admins) {
                            switch(cmd) {
                                case "amiadmin":
                                    ctx._exec_admin_command(from, function() {
                                        ctx.respond(opts.channel, opts.from, "Of course you are, dear");
                                    }, function() {
                                        ctx.respond(opts.channel, opts.from, "Nope");
                                    });
                                    break;
                                case "approve":
                                    ctx._exec_admin_command(from, function() {
                                           ctx.handle_approve(opts);
                                    },
                                    function() {
                                        ctx.respond(opts.channel, opts.from, "Calm down! You need to be an admin to do that.");
                                    });
                                    break;
                                case "cancel":
                                    ctx._exec_admin_command(from, function() {
                                           ctx.handle_cancel(opts);
                                    },
                                    function() {
                                        ctx.respond(opts.channel, opts.from, "Did you know you need to be an admin to do that?");
                                    });
                                    break;
                                case "extend":
                                    ctx._exec_admin_command(from, function() {
                                           ctx.handle_extend(opts);
                                    },
                                    function() {
                                        ctx.respond(opts.channel, opts.from, "Your reach doesn't quite extend this far.");
                                    });
                                    break;

                                default: break;
                            }
                        }
                }

                return;
            }

            if(ctx.config.channel_admins && to == ctx.config.channel_admins) {
                match = message.match(regex_docid);

                if(match) {
                    req("http://habitat.habhub.org/habitat/" + match[0], function(error, response, body) {
                        if (!error && response.statusCode == 200) {
                            var data = JSON.parse(body);
                            ctx.handle_docid_response(to, data, true, true);
                        }
                    });
                }
            }
        });

        // additional handlers
        this.client.addListener('join', function(chan, nick, msg) {
            if(nick.indexOf(ctx.config.nick) === 0) ctx.init_fetch();
        });

        this.client.addListener('error', function(message) {
                console.log('error: ', message);
        });

        // handle all exceptions
        process.on('uncaughtException', function(error) {
            // here we crash for real
            if(ctx.crashed) {
                throw error;
            }

            console.log("Hit an Exception:\n", error);

            ctx.notify("got confused... send help", true, true);
            ctx.crashed = true;

            setTimeout(function() {
                throw error;
            }, 1000);
        });

        // exit gracefully on SIGINT|SIGTERM|SIGQUIT
        var quitHandler =  function() {
            console.log("Exiting...");
            ctx.notify("is going for a nap.", false, true, true);

            setTimeout(function() {
                process.exit();
            }, 1000);
        };

        process.on("SIGINT", quitHandler);
        process.on("SIGTERM", quitHandler);
        process.on("SIGQUIT", quitHandler);

    },

    init_fetch_complete: false,

    init_fetch: function () {
        if(this.init_fetch_complete) return;
        this.init_fetch_complete = true;

        // fetch latest positions from the tracker
        this.fetch_latest_positions();

        this.notify("is back!", false, true, true);
    },

    _exec_admin_command: function(name, success_callback, fail_callback) {
        var ctx = this;

        this.client.whois(name, function(info) {
            if(ctx.config.bot_admins.indexOf(info.account) > -1) {
                if(success_callback) success_callback();
            } else {
                if(fail_callback) fail_callback();
            }
        });
    },

    fetch_next: function() {
        var ctx = this;
        setTimeout(function() { ctx.fetch_latest_positions(); }, 5000);
    },

    fetch_latest_positions: function() {
        var ctx = this;

        req({
            url:"http://spacenear.us/tracker/datanew.php?mode=latest&type=positions&format=json&max_positions=0&position_id="+ctx.storage.tracker.latest_pos_id,
            timeout: 15000,
        },
        function(error, response, body) {
            if (!error && response.statusCode == 200) {
                if(ctx.snus_conn_problem === true) {
                    ctx.snus_conn_problem = false;

                    ctx.notify(["Notice:",[ctx.color.SBJ, "spacenear.us"],"is back"], false, false, true);
                }

                ctx.storage.tracker.timestamp = (new Date()).getTime();

                var data;
                try {
                    data = JSON.parse(body).positions.position;
                }
                catch(err) {
                    console.log("Invalid reply from server:", err);
                    console.log("---------- reply -------------");
                    console.log(body);
                    console.log("------------------------------");
                    ctx.fetch_next();
                    return;
                }

                if(data === undefined || data.length === 0) {
                    console.log("Empty reply from server");
                    console.log("---------- reply -------------");
                    console.log(body);
                    console.log("------------------------------");
                    ctx.fetch_next();
                    return;
                }

                var obj = {};
                var lowest_pos_id = null;
                for(var k in data) {
                    if(lowest_pos_id === null || lowest_pos_id > data[k].position_id) lowest_pos_id = data[k].position_id;

                    var name = data[k].vehicle.toLowerCase();


                    obj[name] = data[k];
                    obj[name].gps_time = new Date(obj[name].gps_time + "Z");
                    obj[name].server_time = new Date(obj[name].server_time + "Z");

                    if(ctx.storage.tracker.data) {
                        if(!ctx.storage.tracker.data.hasOwnProperty(name)) {
                            ctx.notify([
                                "New vehicle on the map:",
                                [ctx.color.SBJ, obj[name].vehicle],
                                "-",
                                [ctx.color.URL, ctx.url_hmt_vehicle + encodeURIComponent(obj[name].vehicle)]
                            ]);
                        } else if(ctx.storage.tracker.data[name].server_time.getTime() + 21600000 < obj[name].server_time.getTime())  {
                            ctx.notify([
                                "New position from",
                                [ctx.color.SBJ, obj[name].vehicle],
                                "after",
                                [ctx.color.SBJ, moment(ctx.storage.tracker.data[name].server_time).fromNow(true)],
                                "silence",
                                "-",
                                [ctx.color.URL, ctx.url_hmt_vehicle + encodeURIComponent(obj[name].vehicle)]
                            ]);
                        }
                    }
                }
                ctx.storage.tracker.data = obj;
                ctx.storage.tracker.latest_pos_id = lowest_pos_id - 1;
            }
            else {
                console.log(error);
                if(ctx.snus_conn_problem === false) {
                    ctx.snus_conn_problem = true;

                    ctx.notify(["Warning: unable to reach",[ctx.color.SBJ, "spacenear.us"],"(will keep retrying)"], false, false, true);
                }
            }

            ctx.fetch_next();
        });
    },

    // wrapper function for nice looking reponses

    respond: function(dest, to, msg, action) {
        action = (action === undefined || typeof action != "boolean") ? false : action;

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

        if(action)
            this.client.action(dest, resp);
        else
            this.client.say(dest, resp);
    },

    // notify

    notify: function(msg, all, action, admins) {
        action = (action === undefined || typeof action != "boolean") ? false : action;
        all = (all === undefined || typeof all != "boolean") ? false : all;
        admins = (admins === undefined || typeof admins != "boolean") ? false : admins;

        var list = (all) ? this.config.channels : this.config.channels_notify;
        list = (admins) ? [this.config.channel_admins] : list;

        for(var k in list) {
            this.respond(list[k], null, msg, action);
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

    _transmission_make_pretty: function(xref) {
        var ctx = this, msg = [];

        if(xref.description !== undefined) msg.push([ctx.color.SBJ, xref.description.trim()], "-");

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

        return msg;
    },

    handle_approve: function(opts) {
        var ctx = this;
        var xref = this.storage.doclookup;

        if(!xref.doc) {
            this.respond(opts.channel, opts.from, "I haven't seen a flight doc id");
            return;
        } else if(xref.doc.type === undefined || xref.doc.type != "flight") {
            this.respond(opts.channel, opts.from, ["I can't aprove a doc of type", [this.color.SBJ, xref.doc.type]]);
            return;
        } else if(xref.doc.type == "flight" && xref.doc.approved) {
            this.respond(opts.channel, opts.from, "That flight doc has already been approved.");
            return;
        } else if(xref.timestamp + 900000 < (new Date()).getTime()) { // 15min
            xref.timestamp = (new Date()).getTime();
            this.respond(opts.channel, opts.from, ["Do you mean to approve the following doc? (if 'yes' type", [this.color.SBJ, "!approve"], "again)"]);
            this.handle_docid_response(opts.channel, xref.doc, true, true);
            return;
        }

        // actually approve the doc
        xref.doc.approved = true;

        var reqOpts = {
            url: "http://"+ctx.config.habitat_creds+"@habitat.habhub.org/habitat/" + xref.doc._id,
            method: "PUT",
            headers: {
                'Content-Type':'application/json; charset=UTF-8',
            },
            body: JSON.stringify(xref.doc)
        };

        req(reqOpts, function(error, response, body) {
            if (!error && response.statusCode == 201) {
                ctx.respond(opts.channel, opts.from, ["Flight", [ctx.color.SBJ, xref.doc.name], [ctx.color.EXT, "("+xref.doc._id+")"], "has been approved! Good luck"]);
            } else {
                var msg = ["Got HTTP", [ctx.color.SBJ, response.statusCode]];

                try {
                    var json = JSON.parse(body);

                    if(json.error) msg.push([ctx.color.EXT, "("+json.error+")"]);
                    if(json.reason) msg.push("-", [ctx.color.SBJ, json.reason]);
                } catch(e) {}

                ctx.respond(opts.channel, opts.from, msg);
            }
        });
    },

    handle_cancel: function(opts) {
        var ctx = this;

        if(opts.args === "") {
                ctx.respond(opts.channel, opts.from, ["Usage: .cancel <flight doc id>"]);
                return;
        }

        var match = opts.args.match(this.regex_docid);

        // invalid doc id
        if(!match) {
                ctx.respond(opts.channel, opts.from, ["That's not a valid doc id"]);
                return;
        }

        // handy doc cancel request
        var cancel_doc = function(doc) {
            doc.approved = false;

            var reqOpts = {
                url: "http://"+ctx.config.habitat_creds+"@habitat.habhub.org/habitat/" + doc._id,
                method: "PUT",
                headers: {
                    'Content-Type':'application/json; charset=UTF-8',
                },
                body: JSON.stringify(doc)
            };

            req(reqOpts, function(error, response, body) {
                if (!error && response.statusCode == 201) {
                    ctx.respond(opts.channel, opts.from, ["Flight", [ctx.color.SBJ, doc.name], [ctx.color.EXT, "("+doc._id+")"], "is no longer approved."]);
                } else {
                    var msg = ["Got HTTP", [ctx.color.SBJ, response.statusCode]];

                    try {
                        var json = JSON.parse(body);

                        if(json.error) msg.push([ctx.color.EXT, "("+json.error+")"]);
                        if(json.reason) msg.push("-", [ctx.color.SBJ, json.reason]);
                    } catch(e) {}

                    ctx.respond(opts.channel, opts.from, msg);
                }
            });
        };

        req("http://habitat.habhub.org/habitat/" + match[0], function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var doc = JSON.parse(body);
                if(doc.type !== "flight") {
                    ctx.respond(opts.channel, opts.from, ["That's not flight doc"]);
                    return;
                }

                cancel_doc(doc);
            }
        });
    },

    handle_extend: function(opts) {
        var ctx = this;
        var args = opts.args.split(' ', 2)
        var docid = args[0];
        var reltime = args[1];

        if(args.length < 2) {
            ctx.respond(opts.channel, opts.from, ["Command requires at least 2 arguments (docid and relative time)"]);
            return;
        }

        var match = docid.match(ctx.regex_docid);

        // invalid doc id
        if(!match) {
            ctx.respond(opts.channel, opts.from, ["That's not a valid doc id"]);
            return;
        }

        var match = ctx.regex_reltime.exec(reltime);

        // invalid doc id
        if(!match) {
            ctx.respond(opts.channel, opts.from, ["Second argument is not a valid relative time (e.g 1d, 1h, 30m, 1w)"]);
            return;
        }

        var val = match[1];
        var suffix = match[2];

        // handy doc extend handler
        var extend_doc = function(doc) {
            // extend end date
            var newdate = moment(doc.end).add(val, suffix);
            doc.end = newdate.zone(newdate._tzm).format();

            var reqOpts = {
                url: "http://"+ctx.config.habitat_creds+"@habitat.habhub.org/habitat/" + doc._id,
                method: "PUT",
                headers: {
                    'Content-Type':'application/json; charset=UTF-8',
                },
                body: JSON.stringify(doc)
            };

            req(reqOpts, function(error, response, body) {
                if (!error && response.statusCode == 201) {
                    ctx.respond(opts.channel, opts.from, ["Flight window for",
                                                          [ctx.color.SBJ, doc.name],
                                                          [ctx.color.EXT, "("+doc._id+")"],
                                                          "has been extended to",
                                                           [ctx.color.SBJ, moment(new Date(doc.end)).calendar()]
                                                         ]);
                } else {
                    var msg = ["Got HTTP", [ctx.color.SBJ, response.statusCode]];

                    try {
                        var json = JSON.parse(body);

                        if(json.error) msg.push([ctx.color.EXT, "("+json.error+")"]);
                        if(json.reason) msg.push("-", [ctx.color.SBJ, json.reason]);
                    } catch(e) {}

                    ctx.respond(opts.channel, opts.from, msg);
                }
            });
        };

        req("http://habitat.habhub.org/habitat/" + docid, function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var doc = JSON.parse(body);
                if(doc.type !== "flight") {
                    ctx.respond(opts.channel, opts.from, ["That's not flight doc"]);
                    return;
                }

                extend_doc(doc);
            }
        });
    },

    handle_docid_response: function(channel, doc, shortid, context, addurl) {
        var ctx = this;

        // handle variables
        shortid = (shortid === undefined || typeof shortid != "boolean") ? false : shortid;
        context = (context === undefined || typeof context != "boolean") ? false : context;
        addurl = (addurl === undefined || typeof addurl != "boolean") ? false : addurl;

        // remember the doc
        if(context) {
            this.storage.doclookup.doc = doc;
            this.storage.doclookup.timestamp = (new Date()).getTime();
        }

        var short_id = (shortid) ? doc._id.substr(-4) : doc._id;
        var msg;

        switch(doc.type) {
            case "payload_telemetry":
                var raw = new Buffer(doc.data._raw, 'base64').toString("ascii").trim();
                this.respond(channel,"", ["Payload telemetry", [this.color.SBJ, doc._id],[this.color.EXT,(doc.data._parsed)?"(parsed)":"(not parsed)"],"raw:", [this.color.SBJ, raw]]);

                if(addurl) this.respond(channel, "", ["Raw:", [this.color.URL,"http://habitat.habhub.org/monocle/?uri=habitat/"+doc._id]]);
                break;
            case "flight":
                var lat = this.format_number(doc.launch.location.latitude, 5);
                var lng = this.format_number(doc.launch.location.longitude, 5);
                msg = ["Flight", [this.color.SBJ, doc.name]];

                // main info
                msg.push([this.color.EXT, "("+short_id+", "+(doc.approved?"approved":"not approved")+", "+doc.payloads.length+" payload"+(doc.payloads.length > 1 ? 's':'')+")"]);

                this.respond(channel,"", msg); msg = [];

                // metadata
                msg.push("Project", [this.color.SBJ, doc.metadata.project],"by",[this.color.SBJ, doc.metadata.group]);
                this.respond(channel,"", msg); msg = [];

                // window
                msg.push("Window:", [this.color.SBJ, moment(new Date(doc.start)).calendar() + " UTC"],"to",[this.color.SBJ, moment(new Date(doc.end)).calendar() + " UTC"]);

                //timezone
                var tzoffset = -(moment(doc.start)._tzm) / 60;
                tzoffset = (tzoffset >= 0) ? "+"+tzoffset : tzoffset;
                msg.push([this.color.EXT, "("+doc.launch.timezone+", "+tzoffset+")"]);

                this.respond(channel,"", msg); msg = [];

                // launch time
                msg.push("Launch:", [this.color.SBJ, moment(new Date(doc.launch.time)).calendar() + " UTC"]);

                // place
                msg.push("from", [this.color.SBJ, doc.metadata.location]);
                msg.push([this.color.EXT, "("+lat+","+lng+")"]);

                this.respond(channel,"", msg);

                if(addurl) this.respond(channel, "", ["Raw:", [this.color.URL,"http://habitat.habhub.org/monocle/?uri=habitat/"+doc._id]]);

                if(!doc.approved && doc.payloads.length) {
                    var nPayloads = doc.payloads.length;
                    var nFound = 0;
                    var count = 0;
                    var statuses = [];
                    var found = {};

                    // nessesary to run queries in order and to avoid race condition
                    var next_query = function() {
                        var id = doc.payloads[count++];

                        req("http://habitat.habhub.org/habitat/_design/payload_telemetry/_view/payload_time?limit=1&startkey=[%22"+id+"%22,{}]&descending=true&include_docs=true", function(error, response, body) {
                            if(!error && response.statusCode == 200) {
                                try {
                                    var json = JSON.parse(body);

                                    // test if we got the a valid result
                                    if(json.rows !== undefined &&
                                       json.rows.length !== 0 &&
                                       doc.payloads.indexOf(json.rows[0].key[0]) !== -1
									) {
										json = json.rows[0];
										found[json.key[0]] = 1;
										nFound++;

										var docStatus = json.key[0].substr(-4);
										docStatus += ", " + moment(json.key[1]*1000).fromNow();

										// if the payload_telemtry is not parsed, report error
										if(json.doc.data === undefined) docStatus = "error";
										// if _fix_invalid flag is true
										else if(json.doc.data.hasOwnProperty("_fix_invalid") && json.doc.data._fix_invalid === true) {
											docStatus += ", nofix";
										}

										statuses.push([ctx.color.SBJ, json.doc.data.payload],[ctx.color.EXT, "("+docStatus+")"]);
									}
                                } catch (e) {
                                    console.error(e);
                                }

                            }

                            // run next query, until we've resolved all payloads
                            if(count != nPayloads) {
                                next_query();
                            }
                            else{
                                var msg = ["Payload parse status:"];

                                if(statuses.length) {
                                    msg = msg.concat(statuses);
                                }

                                if(nFound != nPayloads) {
                                    var untested_ids = [];

                                    for(var k in doc.payloads) if(!found.hasOwnProperty(doc.payloads[k])) untested_ids.push(doc.payloads[k].substr(-4));

                                    if(statuses.length) msg.push("and");

                                    msg.push([ctx.color.SBJ, nPayloads - nFound], "untested", [ctx.color.EXT, "("+untested_ids.join(',')+")"]);
                                }

                                ctx.respond(channel,"", msg);
                            }
                        });
                    };

                    next_query();

                }
                break;
            case "payload_configuration":
                var k;
                msg = ["Payload config",[this.color.SBJ, doc.name], [this.color.EXT, "("+short_id+")"]];

                if(addurl) msg.push("-", [this.color.URL,"http://habitat.habhub.org/monocle/?uri=habitat/"+doc._id]);

                this.respond(channel,"", msg);

                // display callsigns
                msg = ["Callsign(s):"];
                if(doc.sentences.length === 0) {
                    msg.push("none");
                    this.respond(channel, "", msg);
                }
                else {
                    var last = doc.sentences.length - 1;
                    for(k in doc.sentences) msg.push([this.color.SBJ, doc.sentences[k].callsign + ((last != k)?',':'')]);

                    this.respond(channel, "", msg);
                }


                // display transmissions
                if(doc.transmissions.length > 0) {
                    for(k in doc.transmissions) {
                        var xref = doc.transmissions[k];
                        msg = ["Transmission #"+k+":"];

                        msg = msg.concat(this._transmission_make_pretty(xref));

                        this.respond(channel,"", msg);
                    }
                }

                // payload status
                req("http://habitat.habhub.org/habitat/_design/payload_telemetry/_view/payload_time?limit=1&startkey=[%22"+doc._id+"%22,{}]&descending=true&include_docs=true", function(error, response, body) {
                    if(!error && response.statusCode == 200) {
                        try {
                            var json = JSON.parse(body);
                            var msg = ["Last parsed:"];

                            // test if we got the a valid result
                            if(json.rows === undefined ||
                               json.rows.length === 0 ||
                               json.rows[0].key[0] != doc._id) {

                                msg.push([ctx.color.SBJ, "never"]);
                            }
                            else {
                                json = json.rows[0];

                                var docStatus = moment(json.key[1]*1000).fromNow();

                                // if the payload_telemtry is not parsed, report error
                                if(json.doc.data === undefined) docStatus = "error";
                                // if _fix_invalid flag is true
                                else if(json.doc.data.hasOwnProperty("_fix_invalid") && json.doc.data._fix_invalid === true) {
                                    docStatus += ", nofix";
                                }

                                msg.push([ctx.color.SBJ, docStatus]);
                            }
                            ctx.respond(channel,"", msg);

                        } catch (e) {
                            console.error(e);
                        }

                    }
                });


                break;
            default:
                if('type' in doc) {
                    this.respond(channel,"", ["Doc", [this.color.SBJ,doc._id], "is of type", [this.color.SBJ, doc.type], "-", [this.color.URL,"http://habitat.habhub.org/monocle/?uri=habitat/"+doc._id]]);
                } else {
                    this.respond(channel,"", ["Doc", [this.color.SBJ,doc._id], "is of unknown type -", [this.color.URL,"http://habitat.habhub.org/monocle/?uri=habitat/"+doc._id]]);
                }
        }
    },

    // handle aprs

    handle_aprs: function(opts) {
        var ctx = this;
        var args = opts.args.split(' ');
        var method = "GET";

        // handle subcmd
        switch(args[0]) {
            case "help":
                ctx.handle_help(opts, "#aprs_gateway");
                return;
            // add APRS callsign to be imported
            case "add":
            // remove a callsign
            case "remove":
                method = (args[0] == "add") ? "PUT" : "DELETE";

                if(args.length == 1 || args[1] === "") {
                    ctx.respond(opts.channel, opts.from, "You need to specify a valid APRS callsing");
                    return;
                }

                callsign = args[1].toUpperCase();
                display_callsign = (args.length > 2) ? args[2] : null;

                body = { callsign: callsign, display_callsign: display_callsign };

                this._exec_admin_command(opts.from, function() {
                    req({
                        url: "http://127.0.0.1:9993/aprs/importer",
                        json: true,
                        body: body,
                        method: method,
                        timeout: 2000
                    }, function(error, response, body) {
                        if(!error && response.statusCode == 200 && body.status == "ok") {
                            var msg = [];
                            switch(args[0]) {
                                case "add":
                                        msg.push("Added", [ctx.color.SBJ, callsign]);

                                        if(display_callsign !== null) msg.push("as",[ctx.color.EXT, "("+display_callsign+")"]);

                                        msg.push("to APRS Importer");
                                    break;
                                case "remove":
                                        msg.push("Removed", [ctx.color.SBJ, callsign]);

                                        if(display_callsign !== null) msg.push("as",[ctx.color.EXT, "("+display_callsign+")"]);

                                        msg.push("from APRS Importer");
                                    break;
                            }
                            ctx.respond(opts.channel, opts.from, msg);
                        } else {
                            if(response === undefined) {
                                ctx.respond(opts.channel, opts.from, "APRS Service API didn't respond in time");
                            } else {
                                ctx.respond(opts.channel, opts.from, "Error: " + body.message);
                            }
                        }
                    });
                }, function() {
                    ctx.respond(opts.channel, opts.from, "You need to be an admin to do that.");
                });

                return;
            case "find":
            case "info":
            case "telemetry":
            case "ping":
                if(args.length == 1 || args[1] === "") {
                    ctx.respond(opts.channel, opts.from, "You need to specify a callsign or pattern");
                    return;
                }

                var mode = args[0];
                var pattern = args[1].toUpperCase();

                req({url:"http://127.0.0.1:9993/aprs/info/"+pattern, json: true, timeout: 2000}, function(error, response, body) {
                        if(!error && response.statusCode == 200 && body.status == "ok") {
                            if(body.rows === 0) {
                                ctx.respond(opts.channel, opts.from, "No matches found");
                                return;
                            } else {
                                var toomany = false;

                                if(['telemetry','find'].indexOf(mode) > -1 && body.rows > 3) toomany = true;
                                else if(mode == "info" && body.rows > 1) toomany = true;
                                else if(mode == "ping" && body.rows > 15) toomany = true;

                                if( toomany ) {
                                    var url = "http://aprs.fi/";

                                    if(['telemetry','info'].indexOf(mode) > -1) url += mode + "/";

                                    ctx.respond(opts.channel, opts.from, ["Found", [ctx.color.SBJ, body.rows], "results. So many -", [ctx.color.URL, url+pattern]]);
                                    return;
                                }
                            }

                            var msg = [];

                            switch(mode) {
                                case "info":
                                case "find":
                                case "telemetry":
                                    body.result.forEach( function(row) {
                                        if( !row.hasOwnProperty('info') ) {
                                            if(mode == "info") ctx.respond(opts.channel, opts.from, "No matches found");
                                            return;
                                        }

                                        var msg_t = [];
                                        var msg_info = [];

                                        // generate telemetry message line
                                        if(['info','telemetry'].indexOf(mode) > -1 &&
                                            'telemetry' in row.info
                                          )  {
                                            // if telemetry is not setup use default values
                                            // channel names from Ch1 to Ch5
                                            if( !row.hasOwnProperty('tPARM') ) {
                                                row.tPARM = Array.apply(0,Array(5)).map(function(v,i) { return "Ch" + (i+1); });
                                            }
                                            // equations as [0,1,0]
                                            if( !row.hasOwnProperty('tEQNS') ) {
                                                row.tEQNS = Array.apply(0,Array(5)).map(function() { return [0,1,0]; });
                                            }

                                            row.info.telemetry.vals.forEach(function(val, index) {
                                                // skip noname paramters
                                                if(row.tPARM[index] === "") return;

                                                val = row.tEQNS[index][0] * Math.pow(val, 2) + val * row.tEQNS[index][1] + row.tEQNS[index][2];
                                                val = Math.round(val * 10000) / 10000;

                                                msg_t.push( [ctx.color.SBJ, row.tPARM[index]] );

                                                if('tUNIT' in row && row.tUNIT[index] !== "") {
                                                    val = val + " " + row.tUNIT[index];
                                                }

                                                msg_t.push( [ctx.color.EXT, val] );
                                            });

                                        }

                                        // if it's only the telemetry subcommand, send message and stop here
                                        if(mode == "telemetry") {
                                            if(msg_t.length === 0) msg_t.push('none');

                                            msg_t.splice(0,0, [ctx.color.SBJ, row.info.from], 'telemetry:');

                                            ctx.respond(opts.channel, opts.from, msg_t);
                                            return;

                                        } else {
                                            if(msg_t.length) msg_t.splice(0,0, 'Telemetry:');
                                        }

                                        var lat = row.info.latitude;
                                        var lng = row.info.longitude;
                                        var timestamp = row.server_timestamp * 1000;
                                        var dt_minutes = moment().diff(moment(timestamp), 'minutes');

                                        ctx.resolve_location(lat,lng, function(name) {
                                            var msg = [[ctx.color.SBJ, row.info.from], (dt_minutes<5)?"is":"was", "near"];

                                            if(name) {
                                                msg.push([ctx.color.SBJ, name], [ctx.color.EXT, '('+ctx.format_number(lat,5)+','+ctx.format_number(lng,5)+')']);
                                            }
                                            else {
                                                msg.push([ctx.color.SBJ, ctx.format_number(lat,5)+','+ctx.format_number(lng,5)]);
                                            }

                                            if('altitude' in row.info) msg.push("at", [ctx.color.SBJ, ctx.format_number(row.info.altitude,0) + " meters"]);

                                            if(dt_minutes >= 5) msg.push("about", [ctx.color.SBJ, moment(timestamp).fromNow()]);

                                            var url = "http://aprs.fi/";
                                            if(mode == "info") url += mode + "/";

                                            msg.push("-", [ctx.color.URL, url+row.info.from]);

                                            ctx.respond(opts.channel, opts.from, msg);

                                            // in info mode we provide detailed info about the callsign
                                            if(mode == "info") {
                                                msg = ["Path:", [ctx.color.SBJ, row.info.from + ">" + row.info.to], "via", [ctx.color.SBJ, row.info.path.join(',')]];
                                                ctx.respond(opts.channel, opts.from, msg);

                                                msg = ["Symbol:", [ctx.color.SBJ, "" + row.info.symbol_table + row.info.symbol]];

                                                if('speed' in row.info) msg.push("Speed:", [ctx.color.SBJ, Math.round(row.info.speed) +"kmph"]);
                                                if('course' in row.info) msg.push("Course:", [ctx.color.SBJ, row.info.course + '°']);
                                                if('bearing' in row.info) msg.push("Bearing:", [ctx.color.SBJ, row.info.bearing + '°']);
                                                if('nrq' in row.info) msg.push("NRQ:", [ctx.color.SBJ, row.info.nrq]);
                                                if('radiorange' in row.info) msg.push("Radio range:", [ctx.color.SBJ, Math.round(row.info.radiorange) + "km"]);
                                                if('mtype' in row.info) msg.push("MicE message:", [ctx.color.SBJ, row.info.mtype]);

                                                ctx.respond(opts.channel, opts.from, msg);

                                                if('comment' in row.info) {
                                                    ctx.respond(opts.channel, opts.from, ["Comment:", [ctx.color.SBJ, row.info.comment]]);
                                                }

                                                if('status' in row) {
                                                    ctx.respond(opts.channel, opts.from, ["Status:", [ctx.color.SBJ, row.status]]);
                                                }

                                                // send telemetry message if there is one
                                                if(msg_t.length) ctx.respond(opts.channel, opts.from, msg_t);
                                            }
                                        });
                                    });
                                    break;
                                case "ping":
                                    msg = ["Latest contact:"];

                                    // filter objects without info
                                    body.result = body.result.filter(function(row) { return row.hasOwnProperty('info'); });

                                    var len = body.result.length;

                                    body.result.forEach(function(row,index) {
                                        if( !row.hasOwnProperty('info') ) return;

                                        msg.push( [ctx.color.SBJ, row.info.from] );
                                        msg.push( [ctx.color.EXT, "(" + moment(row.server_timestamp*1000).fromNow() +")" + (index+1 < len ? ',':'')] );
                                    });
                                    ctx.respond(opts.channel, opts.from, msg);
                                    break;
                            }
                        } else {
                            if(response === undefined) {
                                ctx.respond(opts.channel, opts.from, "APRS Service API didn't respond in time");
                            } else {
                                ctx.respond(opts.channel, opts.from, "Error: " + body.message);
                            }
                        }
                });
                break;
            case "":
            case "list":
                req({url:"http://127.0.0.1:9993/aprs/importer", json: true, timeout: 2000}, function(error, response, body) {
                        if(!error && response.statusCode == 200 && body.status == "ok") {
                            var len = Object.keys(body.result).length;

                            if(len === 0) {
                                ctx.respond(opts.channel, opts.from, "Tracking via APRS: none");
                            } else {
                                var msg = ["Tracking via APRS:"];
                                var count = 0;

                                for(var callsign in body.result) {
                                    count += 1;

                                    if(body.result[callsign].display_callsign === null) {
                                        msg.push([ctx.color.SBJ, callsign + ((len==count)?'':',')]);
                                    } else {
                                        msg.push([ctx.color.SBJ, callsign],
                                                 [ctx.color.EXT, "("+body.result[callsign].display_callsign+")" + ((len==count)?'':',')]);
                                    }
                                }

                                ctx.respond(opts.channel, opts.from, msg);
                            }
                        } else {
                            if(response === undefined) {
                                ctx.respond(opts.channel, opts.from, "APRS Service API didn't respond in time");
                            } else {
                                ctx.respond(opts.channel, opts.from, "Error: " + body.message);
                            }
                        }
                });
                break;
            case "list-bal":
            case "list-bal-url":
                var interval = (args.length > 1) ? args[1] : 'NaN';
                interval = Math.min(24, Math.max(0, interval));

                if(isNaN(interval)) {
                    ctx.respond(opts.channel, opts.from, "Expected argument to be an integer: 0-24");
                    break;
                }

                req({url:"http://127.0.0.1:9993/aprs/allballoons/"+interval, json: true, timeout: 2000}, function(error, response, body) {
                        if(!error && response.statusCode == 200 && body.status == "ok") {
                            if(body.result.length === 0) {
                                ctx.respond(opts.channel, opts.from, "Recent balloons: none");
                            } else {
                                // aprs.fi can only search for 20 callsigns at a time
                                for(var i = 0, ii = body.result.length; i < ii; i += 20 ) {
                                    if(args[0] == "list-bal") {
                                        ctx.respond(opts.channel, opts.from, "Recent balloons: "+body.result.slice(i,i+20).join(", "));
                                    } else {
                                        ctx.respond(opts.channel, opts.from, "Recent balloons: http://aprs.fi/"+body.result.slice(i,i+20).join(","));
                                    }
                                }
                            }
                        } else {
                            if(response === undefined) {
                                ctx.respond(opts.channel, opts.from, "APRS Service API didn't respond in time");
                            } else {
                                ctx.respond(opts.channel, opts.from, "Error: " + body.message);
                            }
                        }
                });
                break;
            case "status":
                req({url:"http://127.0.0.1:9993/aprs/status/", json: true, timeout: 2000}, function(error, response, body) {
                        if(!error && response.statusCode == 200 && body.status == "ok") {
                            var msg = ["APRS Gateway:"];

                            for(var key in body.stats) {
                                var value = body.stats[key];

                                if(key == 'upsince') {
                                    key = 'uptime';
                                    if(value === 0) {
                                        value = "OFFLINE";
                                    } else {
                                        value = moment(value*1000).fromNow(true);
                                    }
                                }

                                msg.push([ctx.color.SBJ, key], [ctx.color.EXT, value]);
                            }

                            ctx.respond(opts.channel, false, msg);
                        } else {
                            if(response === undefined) {
                                ctx.respond(opts.channel, opts.from, "APRS Service API didn't respond in time");
                            } else {
                                ctx.respond(opts.channel, opts.from, "Error: " + body.message);
                            }
                        }
                });
                break;
            default:
                break;
        }
    },

    // handle hysplit

    handle_hysplit: function(opts) {
        if(opts.args.split(' ')[0] == "help") {
            this.handle_help(opts, "#hysplit");
            return;
        }

        if(this.storage.hysplit.timestamp + 30000 > (new Date()).getTime()) {
                    this.reply_hysplit(opts);
        }
        else {
            var ctx = this;

            req('http://spacenear.us/tracker/datanew.php?type=hysplit&format=json', function (error, response, body) {
                if (!error && response.statusCode == 200) {
                    ctx.storage.hysplit.timestamp = (new Date()).getTime();
                    ctx.storage.hysplit.data = JSON.parse(body);
                    ctx.storage.hysplit.match = {};

                    for(var k in ctx.storage.hysplit.data) ctx.storage.hysplit.match[k.toLowerCase()] = k;

                    ctx.reply_hysplit(opts);
                }
            });
        }
    },

    reply_hysplit: function(opts) {
        var ctx = this;
        var args = opts.args.split(' ');
        var show_gif = true;
        var name = args[0];

        // handle subcmd
        switch(args[0]) {
            // run a single job given a callsign
            case "run":
            // add a callsign to defaults
            case "add":
            // remove a callsign to defaults
            case "remove":
            // clear all callsigns from defeaults
            case "clear":
            // rerun hysplits for all callsign in defaults
            case "rerun":

                if(['rerun','clear'].indexOf(args[0]) == -1 && (args.length == 1 || args[1] === "")) {
                    ctx.respond(opts.channel, opts.from, "You need to specify a callsign from the map");
                    return;
                }

                name = (args.length > 1) ? args[1] : "cannot-be-empty";

                this._exec_admin_command(opts.from, function() {
                    req("http://spacenear.us/tracker/single_hysplit.php?key="+ctx.config.hysplit_key+"&action="+args[0]+"&vehicle="+encodeURIComponent(name)+"&_"+(new Date()).getTime(), function(error, response, body) {
                        if(!error && response.statusCode == 200 && body == "ok") {
                            switch(args[0]) {
                                case "run":
                                    ctx.respond(opts.channel, opts.from, "Your job has been added to the queue. Check in a few minutes"); break;
                                case "clear":
                                    ctx.respond(opts.channel, opts.from, "Cleared defaults"); break;
                                case "rerun":
                                    ctx.respond(opts.channel, opts.from, "Running HYSPLIT jobs for all defaults. Hold on to your hats"); break;
                                case "add":
                                    ctx.respond(opts.channel, opts.from, ["Added", [ctx.color.SBJ, name], "to defaults"]); break;
                                case "remove":
                                    ctx.respond(opts.channel, opts.from, ["Removed", [ctx.color.SBJ, name], "from defaults"]); break;
                            }
                        } else {
                            ctx.respond(opts.channel, opts.from, "Error while trying to run your request... help");
                        }
                    });
                }, function() {
                    ctx.respond(opts.channel, opts.from, "You need to be an admin to do that.");
                });

                return;

            // list callsigns in the defaults file
            case "defaults":
                req("http://spacenear.us/tracker/hysplit_defaults.json?_"+(new Date()).getTime(), function(error, response, body) {
                    if(!error && response.statusCode == 200) {
                        defaults = JSON.parse(body);

                        if(defaults.length === 0) {
                            ctx.respond(opts.channel, opts.from, "HYSPLIT defaults: none");
                        }
                        else {
                            ctx.respond(opts.channel, opts.from, ["HYSPLIT defaults:", [ctx.color.SBJ, defaults.join(", ")]]);
                        }
                    }
                });

                return;
            // list callsigns with available hysplit
            case "":
            case "list":
                var callsigns = Object.keys(this.storage.hysplit.data);

                if(callsigns.length === 0) {
                    this.respond(opts.channel, opts.from, "No HYSPLITs are currently available");
                }
                else {
                    this.respond(opts.channel, opts.from, [
                            "HYSPLIT available for:",
                            [this.color.SBJ, callsigns.join(', ')]
                            ]);
                }
                return;
            case "kml":
            case "kmz":
                show_gif = false;
                name = args[1];
                break;
            case "gif":
            case "get":
                if(args.length < 2) break;

                name = args[1];
                break;
            default:
                break;
        }

        name = name.toLowerCase();
        if(name === "") return;

        // if no subcmd match, assume it's a callsign and look for hysplit
        if(name in this.storage.hysplit.match) {
            name = this.storage.hysplit.match[name];

            var url = (show_gif) ? this.storage.hysplit.data[name].url_gif : this.storage.hysplit.data[name].url_kmz;

            this.respond(opts.channel, opts.from, [
                    "HYSPLIT for",
                    [this.color.SBJ, name],
                    '-',
                    [this.color.URL, url]
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
            var timestamp = this.storage.tracker.data[callsignl].gps_time;
            var dt_minutes = moment().diff(moment(timestamp), 'minutes');
            var ctx = this;

            this.resolve_location(lat,lng, function(name) {
                var msg = [[ctx.color.SBJ, callsign], (dt_minutes<5)?"is":"was", (alt>1000)?"over":"near" ];

                if(name) {
                    msg.push([ctx.color.SBJ, name], [ctx.color.EXT, '('+ctx.format_number(lat,5)+','+ctx.format_number(lng,5)+')']);
                }
                else {
                    msg.push([ctx.color.SBJ, ctx.format_number(lat,5)+','+ctx.format_number(lng,5)]);
                }

                msg.push("at", [ctx.color.SBJ, ctx.format_number(alt,0) + " meters"]);

                if(dt_minutes >= 5) msg.push("about", [ctx.color.SBJ, moment(timestamp).fromNow()]);

                ctx.respond(opts.channel, opts.from, msg);
            });

        }
        else {
            this.respond(opts.channel, opts.from, "I haven't got a clue");
        }
    },

    handle_flip: function(opts) {
        var ctx = this;
        ctx.respond(opts.channel, opts.from, ["You got:", [ctx.color.SBJ, ((Math.random() > 0.5) ? "Heads" : "Tails")] ]);
    },

    handle_help: function(opts, suffix) {
        var ctx = this;
        var url = 'https://ukhas.org.uk/spacenearus_irc_bot';
        if(suffix) {
            url += suffix;
        }
        ctx.respond(opts.channel, opts.from, ['Here you go:', [ctx.color.URL, url]]);
    },

    handle_8ball: function(opts) {
        var ctx = this;
        var answers = [
            // positive
            "It is certain",
            "It is decidedly so",
            "Without a doubt",
            "Yes definitely",
            "You may rely on it",
            "As I see it, yes",
            "Most likely",
            "Outlook good",
            "Yes",
            "Signs point to yes",
            // neutral
            "Reply hazy try again",
            "Ask again later",
            "Better not tell you now",
            "Cannot predict now",
            "Concentrate and ask again",
            // negative
            "Don't count on it",
            "My reply is no",
            "My sources say no",
            "Outlook not so good",
            "Very doubtful",
        ];
        var answer = answers[Math.floor(Math.random() * (answers.length - 1))];
        ctx.respond(opts.channel, opts.from, [answer]);
    },

    handle_wiki: function(opts) {
        var ctx = this;

        if(opts.args.trim() === "") {
            ctx.respond(opts.channel, opts.from, ["Here be the wiki, arr:", [ctx.color.URL, "http://ukhas.org.uk"]]);
            return;
        }

        req("http://ukhas.org.uk/start?do=search&id="+encodeURIComponent(opts.args), function(error, response, body) {
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
                        ctx.respond(opts.channel, opts.from, ["Found", [ctx.color.SBJ, match.length], "results for you query -", [ctx.color.URL, "http://ukhas.org.uk/start?do=search&id="+encodeURIComponent(opts.args)]]);
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
        var url = this.url_hmt_vehicle + opts.args.split(/[, ;]/).filter(function(val) { return val !== "";}).join(";");
        this.respond(opts.channel, opts.from, ["Here you go -", [this.color.URL, url]]);
    },

    _payload_match_name: function(name, doc) {
        name = name.toLowerCase();

        // try to match name
        if(name == doc.name.toLowerCase()) return true;
        // try to match callsign of any sentance
        else {
            for(var j in doc.sentences) {
                if(doc.sentences[j].callsign.toLowerCase() == name) return true;
            }
        }

        return false;
    },

    handle_monocle: function(opts) {
		var url = this.url_hmt_monocle;

		if(opts.args !== "") {

			if(opts.args.match(this.regex_docid)) {
				url += "habitat/" + opts.args;
			}
			else {
				url += encodeURIComponent(opts.args);
			}
		}
		else if(this.storage.doclookup &&
				this.storage.doclookup.doc &&
				this.storage.doclookup.doc.type
		) {
			url += "habitat/" + this.storage.doclookup.doc._id;
		}
		else {
			this.respond(opts.channel, opts.from, ["Are you certain you know what you are doing?"]);
			return;
		}

        this.respond(opts.channel, opts.from, ["Here you go -", [this.color.URL, url]]);
    },

    // habitat stuff
    handle_id: function(opts) {
        var ctx = this;
        var match = opts.args.match(this.regex_docid);

        // try and match 32 or 64 long doc id hash
        if(match) {
            req("http://habitat.habhub.org/habitat/" + match[0], function(error, response, body) {
                if (!error && response.statusCode == 200) {
                    var data = JSON.parse(body);
                    ctx.handle_docid_response(opts.channel, data, false, false, true);
                }
            });

            return;
        }

        // fallback and try to resolve 4 char short doc id or payload callsign, returns the flight doc

        // lookup table for duplicates
        var lookup = {};

        var callback = function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var data = JSON.parse(body);

                if(data.rows.length) {
                    // if the argument is a callsign, try to find the payload_configuration for flight_id
                    for(var k in data.rows) {
                        var xref = data.rows[k];
                        var argLower = opts.args.toLowerCase();
                        var match = false;

                        // first try to match short id
                        if(xref.doc._id.substr(-4) == argLower) match = true;
                        // then if its payload config try to match name or callsign
                        else if(xref.doc.type == "payload_configuration") {
                            match = ctx._payload_match_name(argLower, xref.doc);
                        }


                        // we have match, repond
                        if(match) {
                            // dont print duplicates
                            if(lookup.hasOwnProperty(xref.doc._id)) continue;
                            else lookup[xref.doc._id] = true;

                            ctx.handle_docid_response(opts.channel, xref.doc, false, false, true);
                        }
                    }
                }
            }
        };


        // query not approved flights
        req("http://habitat.habhub.org/habitat/_design/flight/_view/unapproved_name_including_payloads?include_docs=true", callback);
        // query approved flights
        req("http://habitat.habhub.org/habitat/_design/flight/_view/end_start_including_payloads?include_docs=true&startkey=["+((new Date()).getTime()/1000)+"]", callback);
    },

    handle_flights: function(opts) {
        var ctx = this;

        req("http://habitat.habhub.org/habitat/_design/flight/_view/end_start_including_payloads?include_docs=true&startkey=["+((new Date()).getTime()/1000)+"]", function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var data = JSON.parse(body);

                if(data.rows.length) {
                    var msg = ["Current flights:"];

                    count = 0;
                    for(var k in data.rows) {
                        var id = data.rows[k].id.substr(-4);
                        var doc = data.rows[k].doc;

                        if(doc.type == "flight" && ctx.ts(doc.start) < (new Date()).getTime()) {
                            msg.push([ctx.color.SBJ, doc.name],[ctx.color.EXT, "("+id+"),"]);
                            count += 1;
                        }
                    }

                    if(count === 0) {
                        ctx.respond(opts.channel, opts.from, "There are no flights currently :(");
                        return;
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
                    var k;
                    for(k in data.rows) {
                        var xref = data.rows[k];

                        if(xref.doc.type == "payload_configuration" && ctx._payload_match_name(opts.args, xref.doc)) {
                            flight_id = xref.id;
                            break;
                        }
                    }

                    for(k in data.rows) {
                        var id = data.rows[k].id;
                        var doc = data.rows[k].doc;

                        var match = (flight_id !== null) ? id == flight_id : id.substr(-4) == opts.args;

                        if(doc.type == "flight" && ctx.ts(doc.start) < (new Date()).getTime() && match) {
                            var msg = ["Flight", [ctx.color.EXT, "(" + id.substr(-4) + "):"], [ctx.color.SBJ, doc.name]];
                            var lat = ctx.format_number(doc.launch.location.latitude, 5);
                            var lng = ctx.format_number(doc.launch.location.longitude, 5);

                            // number of payloads
                            msg.push([ctx.color.EXT, "("+doc.payloads.length+" payload"+(doc.payloads.length > 1 ? 's':'')+")"], "-");

                            // time
                            msg.push("Launch date", [ctx.color.SBJ, moment(new Date(doc.launch.time)).calendar()]);

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
                        var short_id = data.rows[k].id.substr(-4);
                        var doc = data.rows[k].doc;

                        if(doc.type == "payload_configuration" && (short_id == opts.args || ctx._payload_match_name(opts.args, doc))) {
                            found = true;

                            var msg = ["Payload",[ctx.color.SBJ, doc.name], [ctx.color.EXT, "("+short_id+")"]];
                            var callsigns = [], j;

                            if(doc.sentences.length == 1) {
                                msg.push([ctx.color.SBJ, "$$"+doc.sentences[0].callsign]);
                            }
                            else if(doc.sentences.length > 1) {
                                var last = doc.sentences.length - 1;

                                for(j in doc.sentences)
                                    callsigns.push([ctx.color.SBJ, doc.sentences[j].callsign + ((last != j)?',':'')]);
                            }

                            // keep it short if we have less than 2 transmissions
                            if(doc.transmissions.length === 0) {
                                msg.push("- no transmissions");
                                ctx.respond(opts.channel, opts.from, msg);

                                if(callsigns.length > 1) ctx.respond(opts.channel, opts.from, ["Callsigns:"].concat(callsigns));
                            }
                            else if(doc.transmissions.length == 1) {
                                xref = doc.transmissions[0];

                                msg.push("-");
                                msg = msg.concat(ctx._transmission_make_pretty(xref));
                                ctx.respond(opts.channel, opts.from, msg);

                                if(callsigns.length > 1) ctx.respond(opts.channel, opts.from, ["Callsigns:"].concat(callsigns));
                            }
                            // for more than 1 tranmissions, print them on seperate lines
                            else {
                                ctx.respond(opts.channel, opts.from, msg);
                                if(callsigns.length > 1) ctx.respond(opts.channel, opts.from, ["Callsigns:"].concat(callsigns));

                                for(j in doc.transmissions) {
                                    xref = doc.transmissions[j];

                                    msg = ["Tranmission #"+j+":"];

                                    msg = msg.concat(ctx._transmission_make_pretty(xref));
                                    ctx.respond(opts.channel, opts.from, msg);
                                }
                            }
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

    handle_dial: function(opts) {
        var ctx = this;

        req("http://habitat.habhub.org/habitat/_design/flight/_view/end_start_including_payloads?include_docs=true&startkey=["+((new Date()).getTime()/1000)+"]", function(error, response, body) {
            if (!error && response.statusCode == 200) {
                var data = JSON.parse(body);

                if(data.rows.length) {
                    var found = false;
                    var payload_docs = {};

                    // find all payload_configuration ids
                    for(var k in data.rows) {
                        var short_id = data.rows[k].id.substr(-4);
                        var doc = data.rows[k].doc;

                        if(doc.type == "payload_configuration" && (short_id == opts.args || ctx._payload_match_name(opts.args, doc))) {
                            found = true;
                            payload_docs[doc._id] = ["Latest dials for",[ctx.color.SBJ, doc.name], [ctx.color.EXT, "("+short_id+"):"]];
                        }
                    }

                    // use payload_config ids to find the latest telemetry for each one
                    if(found) {
                        var idx = 0;

                        var step_callback = function() {
                            if(idx >= Object.keys(payload_docs).length) return;

                            var next_id = Object.keys(payload_docs)[idx];

                            req("http://habitat.habhub.org/habitat/_design/payload_telemetry/_view/payload_time?startkey=[%22"+next_id+"%22,{}]&include_docs=true&limit=5&descending=true", function(error, response, body) {
                                if (!error && response.statusCode == 200) {
                                    var data = JSON.parse(body);
                                    var freqs = {};

                                    if(data.rows.length >= 0 && data.rows[0].key[0] == next_id) {
                                        for(var k in data.rows) {
                                            for(var callsign in data.rows[k].doc.receivers) {
                                                try {
                                                    var freq = data.rows[k].doc.receivers[callsign].rig_info.frequency;
                                                    if(freq !== undefined) {
                                                        if(freq < 1000000) {
                                                            freqs[freq / 1000] = 1;
                                                        } else {
                                                            freqs[freq / 1000000] = 1;
                                                        }
                                                    }
                                                } catch(e) {
                                                    continue;
                                                }
                                            }

                                        }
                                    }

                                    var msg = payload_docs[next_id];

                                    if(Object.keys(freqs).length === 0) {
                                        msg.push("none");
                                    }
                                    else {
                                        msg.push([ctx.color.SBJ, Object.keys(freqs).join(" MHz, ") + " MHz"]);
                                    }

                                    ctx.respond(opts.channel, opts.from, msg);
                                }

                                idx++;
                                step_callback();
                            });
                        };

                        step_callback();

                    }
                    else {
                        ctx.respond(opts.channel, opts.from, "Can't find a flight doc matching your query");
                    }
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
                    var k;
                    for(k in data.rows) {
                        var xref = data.rows[k];

                        if(xref.doc.type == "payload_configuration" && ctx._payload_match_name(opts.args, xref.doc)) {
                            flight_id = xref.id;
                            break;
                        }
                    }

                    for(k in data.rows) {
                        var id = data.rows[k].id;
                        var doc = data.rows[k].doc;

                        var match = (flight_id !== null) ? id == flight_id : id.substr(-4) == opts.args;

                        if(doc.type == "flight" && ctx.ts(doc.start) < (new Date()).getTime() && match) {
                            ctx.respond(opts.channel, opts.from, [
                                "Flight window for",
                                [ctx.color.SBJ, doc.name],
                                [ctx.color.EXT, "(" + id.substr(-4) + ")"],
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
};

module.exports = bot;

if(module.parent === null) bot.init(config);
