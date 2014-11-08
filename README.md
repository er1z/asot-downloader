asot-downloader
===============

Pretty simple A State of Trance downloader. Uses http://cuenation.com and http://livesets.us sites for file sources.

It can utilize Growl as a notifier.

# How install it

``npm install`` to satisfy dependencies. Befare of ``cue-parser`` libraries - the devs still haven't committed my PR for timestamps longer than 59 minutes. Just keep eye on reverting one file.

# How to use it

1. If you exec ``node index.js``, you'll get the newest podcast downloaded. It's a good idea to put this into your Cron being executed every a few hours on Fridays and Saturdays. ;-)
2. ``node index.js <number>`` starts fetching specified episode.

# Tips

If you have already downloaded CUE or/and MP3, you can put it into specified ``tmp`` directory and get those files used. Just name these files after episode number and voila!

# Configuration

In the ``package.json``:

``growl`` - notification service params. Self-explanatory. Set this key to ``false`` and you'll receive no notifications.
``directories``
    ``tmp`` - working directory
    ``asots`` - a directory where splitted mp3s are placed