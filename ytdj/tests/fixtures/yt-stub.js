/* A stand-in for https://www.youtube.com/iframe_api.
 *
 * The smoke test routes the real script to this file, so the suite needs no
 * network and no actual video playback, while still exercising every call the
 * app makes. The stub records volume writes, so the test can assert the
 * crossfader's gain staging and the call-coalescing behaviour for real.
 *
 * Loaded as a classic script, exactly as the real API is.
 */
(function () {
  var RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  window.__ytStub = { players: [], volumeWrites: [], seeks: [] };

  function Player(element, options) {
    var self = this;
    this.opts = options || {};
    this.vars = this.opts.playerVars || {};
    this.videoId = this.opts.videoId || null;
    this.volume = 100;
    this.muted = false;
    this.state = -1;
    this.rate = 1;
    this.time = Number(this.vars.start || 0);
    this.duration = 212;
    this.startedAt = null;
    this.destroyed = false;

    // Stand in for the iframe the real API injects, so layout and the
    // "player must stay visible" rule are exercised the same way.
    var host = typeof element === 'string' ? document.getElementById(element) : element;
    var frame = document.createElement('iframe');
    frame.title = 'Stubbed YouTube player';
    frame.setAttribute('data-stub-video', String(this.videoId));
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    frame.src = 'about:blank';
    if (host && host.parentNode) host.parentNode.replaceChild(frame, host);
    this.frame = frame;

    window.__ytStub.players.push(this);

    setTimeout(function () {
      if (self.opts.events && self.opts.events.onReady) {
        self.opts.events.onReady({ target: self });
      }
    }, 0);
  }

  Player.prototype._setState = function (state) {
    this.state = state;
    if (this.opts.events && this.opts.events.onStateChange) {
      this.opts.events.onStateChange({ target: this, data: state });
    }
  };

  Player.prototype.playVideo = function () {
    this.startedAt = Date.now();
    this._setState(1);
  };

  Player.prototype.pauseVideo = function () {
    this.time = this.getCurrentTime();
    this.startedAt = null;
    this._setState(2);
  };

  Player.prototype.setVolume = function (v) {
    this.volume = v;
    window.__ytStub.volumeWrites.push({ id: this.videoId, volume: v, at: Date.now() });
  };

  Player.prototype.getVolume = function () {
    return this.volume;
  };

  Player.prototype.mute = function () {
    this.muted = true;
  };

  Player.prototype.unMute = function () {
    this.muted = false;
  };

  Player.prototype.isMuted = function () {
    return this.muted;
  };

  Player.prototype.seekTo = function (seconds, allowSeekAhead) {
    this.time = seconds;
    if (this.startedAt !== null) this.startedAt = Date.now();
    window.__ytStub.seeks.push({ id: this.videoId, seconds: seconds, allowSeekAhead: allowSeekAhead });
  };

  Player.prototype.getCurrentTime = function () {
    if (this.startedAt === null) return this.time;
    return this.time + ((Date.now() - this.startedAt) / 1000) * this.rate;
  };

  Player.prototype.getDuration = function () {
    return this.duration;
  };

  Player.prototype.getPlayerState = function () {
    return this.state;
  };

  Player.prototype.setPlaybackRate = function (r) {
    this.rate = r;
    if (this.opts.events && this.opts.events.onPlaybackRateChange) {
      this.opts.events.onPlaybackRateChange({ target: this, data: r });
    }
  };

  Player.prototype.getPlaybackRate = function () {
    return this.rate;
  };

  Player.prototype.getAvailablePlaybackRates = function () {
    return RATES.slice();
  };

  Player.prototype.getVideoData = function () {
    return { video_id: this.videoId, title: 'Stub track ' + this.videoId, author: 'Stub channel' };
  };

  Player.prototype.cueVideoById = function (arg) {
    this.videoId = typeof arg === 'string' ? arg : arg.videoId;
    this.time = typeof arg === 'object' && arg.startSeconds ? arg.startSeconds : 0;
    this.startedAt = null;
    this.frame.setAttribute('data-stub-video', String(this.videoId));
    this._setState(5);
  };

  Player.prototype.destroy = function () {
    this.destroyed = true;
    if (this.frame && this.frame.parentNode) this.frame.parentNode.removeChild(this.frame);
  };

  window.YT = { Player: Player, PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };

  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
})();
