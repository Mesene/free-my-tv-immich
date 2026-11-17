# Free My TV with an Immich album as the background

This fork adds one thing to [Free My TV](https://github.com/simbasjungles/free-my-tv) for LG and Samsung TVs: the
photos of an Immich album as the home screen's background (`web/photos.js`). They are kept on the TV, so the home
screen opens with one at once; the copy follows the album every 6 hours. Upright photos show whole, over themselves
blurred.

## Settings

In `config.properties` (never committed: it holds the password):

```
immich_server=http://192.168.1.152:30041
immich_email=tele@casa.local
immich_password=...
immich_album=TV background
immich_minutes=10
```

Use an Immich account made for the TV (not an administrator), with only that album shared with it: the email and
password end up inside the package. Leave `immich_album` empty to use every album shared with that account.

## Build

```
python tizen/build.py --generic --config config.properties
```

`--generic` keeps the release's settings (city and currency from the TV's time zone, the TMDB key typed on the TV);
`--config` adds only the Immich settings from the file. Install `FreeMyTV-tizen.wgt` with Apps2Samsung
(*Install a file…*). Keep the `.wgt` to yourself: it holds the password.

## Staying up to date

`main` is an exact copy of the original; `immich-background` (the default branch) is main plus these changes. The
*Sync with upstream* workflow brings the original's new commits in every Monday and opens an issue when they clash.
After a sync, build again and reinstall to get the new version on the TV.
