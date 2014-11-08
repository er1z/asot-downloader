var request = require('request');
var cheerio = require('cheerio');
var fs = require('fs');
var Q = require('q');

var latest = fs.readFileSync('tmp/latest').toString();
var config = require('./package.json');

var argv = process.argv.slice(2);

//todo: debug in correct places

var getPage = function(url){
    var defer = Q.defer();

    request({
        url: url,
        headers:
        {
            'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:31.0) Gecko/20100101 Firefox/31.0',
            'Referer': 'http://cuenation.com'
        }
    }, function(error, response, body){
        if(response.statusCode==200){
            defer.resolve(body);
        }else{
            defer.reject(error);
        }
    });

    return defer.promise;
}

var getEpisodeMetadata = function(body, issue){

    var defer = Q.defer();

    var doc = cheerio(body);

    var list = cheerio('p.list a', doc);

    var re = /([0-9\.]+) \S([0-9]{4}\-[0-9]{2}\-[0-9]{2}).+\[Livesets\.us\]/;

    var found = false;

    list.each(function(i){

        if(i%2 == 0){
            return;
        }

        var elem = cheerio(list).eq(i);
        var title = elem.html();

        var results = re.exec(title);

        if(!results){
            return;
        }

        var episode = results[1];
        var date = results[2];

        if(!issue) {
            if(episode<=latest){
                return false;
            }
        }else{
            if(episode != issue){
                return;
            }
        }

        found = true;

        getPage('http://cuenation.com/'+elem.attr('href'))
            .then(function getComponents(body){

                var doc = cheerio(body);
                var links = cheerio('a.clear', doc);

                var cuelink = 'http://cuenation.com/'+links.eq(0).attr('href');

                var mp3Link = links.eq(1).attr('href');
                mp3Link = decodeURIComponent(mp3Link.substr(mp3Link.indexOf('=')+1));

                return [cuelink, getPage(mp3Link).then(function(body){
                    var doc = cheerio('#veri8 a', body);
                    return doc.eq(0).attr('href');
                })];

            }).spread(function(cuelink,mp3Link){
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

var getCueSheet = function(data){

    var parser = require('cue-parser');

    if(fs.existsSync(config.directories.tmp+'/'+data.episode+'.cue')){
        return parser.parse(config.directories.tmp+'/'+data.episode+'.cue');
    }

    var defer = Q.defer();

    getPage(data.cuesheet)
        .then(function(body){

            fs.writeFileSync(config.directories.tmp+'/'+data.episode+'.cue', body);

            var result = parser.parse(config.directories.tmp+'/'+data.episode+'.cue');

            defer.resolve(
                result
            );
        });

    return defer.promise;
}

var downloadMp3 = function(data){

    if(fs.existsSync(config.directories.tmp+'/'+data.episode+'.mp3')){
        return config.directories.tmp+'/'+data.episode+'.mp3';
    }

    var defer = Q.defer();

    var request = require('request');
    var progress = require('request-progress');
    var ProgressBar = require('progress');

    var bar;
    var previous;

    var start = true;
    var max = 0;

    progress(request(data.mp3), {
        throttle: 2000,  // Throttle the progress event to 2000ms, defaults to 1000ms
        delay: 1000      // Only start to emit after 1000ms delay, defaults to 0ms
    })
        .on('progress', function (state) {

            if(start){
                bar = new ProgressBar('  downloading [:bar] :percent :etas', {
                    complete: '=',
                    incomplete: ' ',
                    width: 20,
                    total: state.total
                });
                start = false;
                max = state.total;
            }

            if(previous){
                bar.tick(state.received-previous);
            }

            previous = state.received;

        })
        .on('error', defer.reject)
        .pipe(fs.createWriteStream('tmp/'+data.episode+'.mp3'))
        .on('close', function (err) {
            bar.tick(max-previous);

            defer.resolve(config.directories.tmp+'/'+data.episode+'.mp3');
        });

    return defer.promise;
}

var notify = function(data){

    if(!config.growl){
        return false;
    }

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

var splitFiles = function(cue,mp3,data){

    var defer = Q.defer();

    var ffmpeg = require('fluent-ffmpeg');
    var slug = require('slug');

    var result = Q();

    var start = '0:0';

    var tracks = cue.files[0].tracks;
    var cwd = config.directories.asots+'/'+data.episode;

    //ignore existing directory
    try{
        require('fs').mkdir(cwd);
    }catch(e){};

    tracks.forEach(function(i,v){

        var stamp = null;
        var duration = null;

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

        (function(start,duration,i){
            result = result.then(function(){
                var defer = Q.defer();

                console.log(i.performer, '-', i.title, start, duration);

                var o = ffmpeg(mp3)
                    .audioCodec('copy')
                    .seekInput(start);

                if(duration){
                    o.duration(duration);
                }

                var options = [
                    '-id3v2_version', '3', '-write_id3v1', '1',
                    '-metadata', 'artist='+i.performer+' ',
                    '-metadata', 'title='+i.title+' ',
                    '-metadata', 'album='+cue.title+' '
                ];
                var filename = (v<10 ? '0'+v : v)+'_'+slug(i.performer, '_')+'_-_'+slug(i.title);

                console.log(filename);

                o.outputOption(options);

                o.on('end', function(){
                    defer.resolve();
                })
                    .on('error', function(err){
                        console.log(err);
                        defer.reject()
                    })
                    .save(cwd+'/'+filename+'.mp3');

                return defer.promise;
            });
        })(start, duration, i);

        start = stamp;

    });

    result.then(function(){
        defer.resolve(data);
    });

    return defer.promise;
}

var markLatest = function(data){
    fs.writeFile(config.directories.tmp+'/latest', data.episode);
}

var cleanup = function(data){
    fs.unlink(config.directories.tmp+'/'+data.episode+'.cue');
    fs.unlink(config.directories.tmp+'/'+data.episode+'.mp3');
};

var task = getPage('http://cuenation.com/?page=cues&folder=asot');

if(argv[0]){
    task = task.then(function(data){
        return getEpisodeMetadata(data, argv[0]);
    });
}else{
    task = task
        .then(getEpisodeMetadata);

}

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
        return [
            markLatest(data),
            cleanup(data),
            notify(data)
        ];
    })
    .fail(function(err){
        console.error(err);
    });
