// imports
var request = require('request');
var cheerio = require('cheerio');
var fs = require('fs');
var Q = require('q');
var ProgressBar = require('progress');

// configuration data
var config = require('./package.json');
// latest issue number
var latest = fs.readFileSync(config.directories.tmp+'/latest').toString();

// are doing a job for specified issue?
var argv = process.argv.slice(2);

/**
 * debugging helper
 * @param String str
 * @param integer level
 */
var debug = function(str,level){
    level = !!level ? level : 1;

    if(config.verbose>=level){
        console.log(str);
    }
}

/**
 * download an URL
 * @param String url
 * @returns {promise|*|Q.promise}
 */
var getPage = function(url){
    var defer = Q.defer();

    debug("Fetching page: "+url, 2);

    request({
        url: url,
        headers:
        {
            'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:31.0) Gecko/20100101 Firefox/31.0',
            'Referer': 'http://cuenation.com'
        }
    }, function(error, response, body){

        debug("Fetched "+body.length+" bytes, HTTP code: "+response.statusCode, 2);

        if(response.statusCode==200){
            defer.resolve(body);
        }else{
            defer.reject(error);
        }
    });

    return defer.promise;
}

/**
 * get newest (or specified) issue metadata
 * @param String body response body from getPage
 * @param Integer issue optional - issue number
 * @returns {promise|*|Q.promise}
 */
var getEpisodeMetadata = function(body, issue){

    if(issue){
        debug("Getting metadata for episode: "+issue);
    }else{
        debug("Getting metadata for newest episode. Latest fetched: "+latest);
    }

    var defer = Q.defer();

    // initialize DOM parser
    var doc = cheerio(body);

    // look up for list with issues
    var list = cheerio('p.list a', doc);

    // regular expression for Livesets.us version
    var re = /([0-9\.]+) \S([0-9]{4}\-[0-9]{2}\-[0-9]{2}).+\[Livesets\.us\]/;

    var found = false;

    // iterate results
    list.each(function(i){

        // we do not need the arrows
        if(i%2 == 0){
            return;
        }

        // select parsed element
        var elem = cheerio(list).eq(i);
        // get its title
        var title = elem.html();

        // check agains expression above
        var results = re.exec(title);

        // nope?
        if(!results){
            return;
        }

        // get issue number and date
        var episode = results[1];
        var date = results[2];

        // check if we have new issue?
        if(!issue) {
            if(episode<=latest){
                debug("No newer episode found");
                return false;
            }
        }else{
            if(episode != issue){
                return;
            }
        }

        debug("Episode found, fetching metadata", 2);

        found = true;

        // get issue page
        getPage('http://cuenation.com/'+elem.attr('href'))
            .then(function getComponents(body){

                debug("Metadata fetched", 2);

                // get download links
                var doc = cheerio(body);
                var links = cheerio('a.clear', doc);

                // cue-sheet download file
                var cuelink = 'http://cuenation.com/'+links.eq(0).attr('href');

                // mp3 door-page link
                var mp3Link = links.eq(1).attr('href');
                mp3Link = decodeURIComponent(mp3Link.substr(mp3Link.indexOf('=')+1));

                debug("Cuesheet link: "+cuelink, 2);
                debug("Mp3 site link: "+mp3Link, 2);

                // return an array with cuelink and mp3 link (focus on getPage - hierarchical defers)
                return [cuelink, getPage(mp3Link).then(function(body){
                    // extract mp3 file link
                    var doc = cheerio('#veri8 a', body);
                    return doc.eq(0).attr('href');
                })];

            }).spread(function(cuelink,mp3Link){

                debug("Fetched mp3 site link: "+mp3Link, 2);

                // build a structure to work with later
                defer.resolve({
                    episode: episode,
                    date: date,
                    cuesheet: cuelink,
                    mp3: mp3Link
                });
            });

        return false;

    });

    if(!found){
        defer.reject('episode not found');
    }

    return defer.promise;
}

/**
 * download cue sheet
 * @param String data
 * @returns {promise|*|Q.promise}
 */
var getCueSheet = function(data){

    var parser = require('cue-parser');

    debug("Getting cuesheet");

    // cached version - skip downloading
    if(fs.existsSync(config.directories.tmp+'/'+data.episode+'.cue')){
        debug("Fetching skipped: found cached");
        return parser.parse(config.directories.tmp+'/'+data.episode+'.cue');
    }

    var defer = Q.defer();

    // download cue
    getPage(data.cuesheet)
        .then(function(body){

            debug("Cuesheet downloaded");

            fs.writeFileSync(config.directories.tmp+'/'+data.episode+'.cue', body);

            var result = parser.parse(config.directories.tmp+'/'+data.episode+'.cue');

            defer.resolve(
                result
            );
        });

    return defer.promise;
}

/**
 * download mp3 file
 * @param String data
 * @returns {promise|*|Q.promise}
 */
var downloadMp3 = function(data){

    debug("Getting mp3 file");

    // cached - skip
    if(fs.existsSync(config.directories.tmp+'/'+data.episode+'.mp3')){
        debug("Found cached mp3 file");
        return config.directories.tmp+'/'+data.episode+'.mp3';
    }

    var defer = Q.defer();

    // imports
    var request = require('request');
    var progress = require('request-progress');

    // progressbar handle
    var bar;
    // previous value
    var previous;

    // flags
    var start = true;
    var max = 0;

    progress(request(data.mp3), {
        throttle: 2000,  // Throttle the progress event to 2000ms, defaults to 1000ms
        delay: 1000      // Only start to emit after 1000ms delay, defaults to 0ms
    })
        .on('progress', function (state) {

            // progress bar initialization
            if(start){
                bar = new ProgressBar('  downloading [:bar] :percent :etas', {
                    complete: '=',
                    incomplete: ' ',
                    width: 30,
                    total: state.total
                });
                start = false;
                max = state.total;
                debug("Mp3 file size: "+max);
            }

            // update step
            if(previous){
                bar.tick(state.received-previous);
            }

            previous = state.received;

        })
        .on('error', defer.reject)
        .pipe(fs.createWriteStream('tmp/'+data.episode+'.mp3'))
        .on('close', function (err) {
            bar.tick(max-previous);

            // resolve with mp3 path
            defer.resolve(config.directories.tmp+'/'+data.episode+'.mp3');
        });

    return defer.promise;
}

/**
 * send notification thru growl
 * @param Object data
 * @returns {boolean}
 */
var notify = function(data){

    if(!config.growl){
        debug("Notifications disabled", 2);
        return false;
    }

    debug("Sending notification", 2);

    var growler = require('growler');

    var myApp = new growler.GrowlApplication('A State of Trance', {
        hostname: config.growl.host, // IP or DNS
        port: config.growl.port, // Default GNTP port
        // timeout: 5000, // Socket inactivity timeout
        icon: fs.readFileSync('icon.png')
    }, {
        password: config.growl.pass // Password is set in the Growl client settings
        // hashAlgorithm: 'SHA512', // MD5, SHA1, SHA256 (default), SHA512
        // encryption: 'AES' // AES, DES or 3DES, by default no encryption
    });

    myApp.setNotifications({
        'Default Notification': {
            displayName: 'A State of Trance',
            enabled: true
        }
    });


    myApp.register(function(err) {
        if (err){
            debug("Growl notification error: "+err);
            throw err;
        }

        myApp.sendNotification('Default Notification', {
            title: 'New episode arrived!',
            text: 'The episode '+data.episode+' has been downloaded!',
            sticky: true
        });

    });

    return true;
}

/**
 * split files by cue-sheet
 * @param Object cue
 * @param String mp3
 * @param Object data
 * @returns {promise|*|Q.promise}
 */
var splitFiles = function(cue,mp3,data){

    debug("Splitting files");

    var defer = Q.defer();

    // imports
    var ffmpeg = require('fluent-ffmpeg');
    var slug = require('slug');

    // result defer
    var result = Q();

    // starting timestamp
    var start = '0:0';

    // aliases
    var tracks = cue.files[0].tracks;
    var cwd = config.directories.asots+'/'+data.episode;

    // ignore existing directory
    try{
        require('fs').mkdir(cwd);
    }catch(e){
        debug(e, 2);
    };


    // progress bar
    var bar = new ProgressBar('  splitting [:bar] :percent :etas', {
        complete: '=',
        incomplete: ' ',
        width: 30,
        total: tracks.length
    });

    tracks.forEach(function(i,v){

        // offset timestamp
        var stamp = null;
        var duration = null;

        // calculation for timings for ffmpeg
        if(tracks[v+1]){
            var time = tracks[v+1].indexes[0].time;
            var currentTime = i.indexes[0].time

            stamp = (time.min%60)+':'+time.sec;

            if(time.min>59){
                stamp = Math.floor(time.min/60)+':'+stamp;
            }

            var nextLength = time.min*60+time.sec;
            var currentLength = currentTime.min*60+currentTime.sec;

            duration = nextLength-currentLength;
        }

        // create copied scope (without this one, i value would have been executed with latest value)
        (function(start,duration,i){
            result = result.then(function(){
                var defer = Q.defer();

                debug("Splitting: "+i.performer+" - "+i.title+", start: "+start+", duration: "+duration, 2);

                // initialize ffmpeg and setup offset
                var o = ffmpeg(mp3)
                    .audioCodec('copy')
                    .seekInput(start);

                if(duration){
                    o.duration(duration);
                }

                // id3 tags - trailing empty space is weird. But necessary. Dunno know, why
                var options = [
                    '-id3v2_version', '3', '-write_id3v1', '1',
                    '-metadata', 'artist='+i.performer+' ',
                    '-metadata', 'title='+i.title+' ',
                    '-metadata', 'album='+cue.title+' '
                ];

                // fs-safe filename
                var filename = (v<10 ? '0'+v : v)+'_'+slug(i.performer, '_')+'_-_'+slug(i.title);

                o.outputOption(options);

                o.on('end', function(){
                    bar.tick();
                    debug("splitting done", 2);
                    defer.resolve();
                })
                .on('error', function(err){
                    debug(err);
                    defer.reject()
                })
                .save(cwd+'/'+filename+'.mp3');

                return defer.promise;
            });
        })(start, duration, i);

        start = stamp;

    });

    // if all files were parsed, move on
    result.then(function(){
        defer.resolve(data);
    });

    return defer.promise;
}

/**
 * store which episode is the latest
 * @param Object data
 */
var markLatest = function(data){
    debug("Marking "+data.episode+" as latest downloaded", 2);
    fs.writeFile(config.directories.tmp+'/latest', data.episode);
}

/**
 * cleanup files
 * @param Object data
 */
var cleanup = function(data){
    debug("Cleaning up", 2);
    fs.unlink(config.directories.tmp+'/'+data.episode+'.cue');
    fs.unlink(config.directories.tmp+'/'+data.episode+'.mp3');
};

////////////////////////////// BOOT

debug("Downloading list");
var task = getPage('http://cuenation.com/?page=cues&folder=asot');

// if specified or newest podcast?
if(argv[0]){
    task = task.then(function(data){
        return getEpisodeMetadata(data, argv[0]);
    });
}else{
    task = task
        .then(getEpisodeMetadata);

}

// self explanatory, IMO
task = task
    .then(function downloadAllFiles(data){
        return [
            getCueSheet(data),
            downloadMp3(data),
            data
        ];
    })
    .spread(splitFiles)
    .then(function makeDone(data){
        var tasks = [
            cleanup(data),
            notify(data)
        ];
        
        if(!argv[0]){
            tasks.unshift(markLatest(data));
        }
        
        return tasks;
    })
    .fail(function(err){
        console.error(err);
    });
