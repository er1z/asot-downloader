var request = require('request');
var cheerio = require('cheerio');
var fs = require('fs');
var Q = require('q');

var latest = fs.readFileSync('tmp/latest').toString();
var config = require('./package.json');

var argv = process.argv.slice(2);

//todo: read config
//todo: debug in correct places
//todo: enable/disable growl
//todo: regard existing mp3

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

var getCueSheet = function(url){
    var defer = Q.defer();

    getPage(url)
        .then(function(data){

            fs.writeFileSync('tmp/cue.cue', data);

            var parser = require('cue-parser');
            var result = parser.parse('tmp/cue.cue');

            defer.resolve(
                result
            );
        });

    return defer.promise;
}

var downloadMp3 = function(url){

    var defer = Q.defer();

    var request = require('request');
    var progress = require('request-progress');
    var ProgressBar = require('progress');

    var bar;
    var previous;

    var start = true;
    var max = 0;

    progress(request(url), {
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
        .pipe(fs.createWriteStream('tmp/mp3.mp3'))
        .on('close', function (err) {
            bar.tick(max-previous);

            defer.resolve('tmp/mp3.mp3');
        });

    return defer.promise;
}

var notify = function(issue, callback){
    var path = require('path');

    var Growl = require('node-notifier').Growl;

    var notifier = new Growl({
        name: 'A State of Trance' // Defaults as 'Node'
    });

    notifier.notify({
        title: 'New podcast!',
        message: 'The '+issue+' has arrived and is ready for playing!',
        icon: path.join(__dirname, 'icon.png'),
        wait: !!callback,
        sticky: true
    }, callback);

    return true;
}

var splitFiles = function(cue,mp3,data){

    var defer = Q.defer();

    var ffmpeg = require('fluent-ffmpeg');
    var slug = require('slug');

    var result = Q();

    var start = '0:0';

    var tracks = cue.files[0].tracks;
    var cwd = 'tmp/'+data.episode;
    require('fs').mkdir(cwd);

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
    fs.writeFile('tmp/latest', data.episode);
}

var cleanup = function(){
    fs.unlink('tmp/cue.cue');
    fs.unlink('tmp/mp3.mp3');
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
            getCueSheet(data.cuesheet),
            downloadMp3(data.mp3),
            data
        ];
    })
    .spread(splitFiles)
    .then(function makeDone(data){
        return [
            markLatest(data),
            cleanup(data),
            notify(data.episode)
        ];
    })
    .fail(function(err){
        console.error(err);
    });
