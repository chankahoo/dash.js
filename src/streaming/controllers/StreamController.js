/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import Stream from '../Stream.js';
import ManifestUpdater from '../ManifestUpdater.js';
import PlaybackController from './PlaybackController.js';
import TimeSyncController from '../TimeSyncController.js';
import MediaPlayer from '../MediaPlayer.js';
import EventBus from '../utils/EventBus.js';
import ProtectionModel from '../models/ProtectionModel.js';
import MediaController from './MediaController.js';
import Events from '../Events.js';
import URIQueryAndFragmentModel from '../models/URIQueryAndFragmentModel.js';
import VideoModel from '../models/VideoModel.js';

let StreamController = function () {
    "use strict";

    /*
     * StreamController aggregates all streams defined in the manifest file
     * and implements corresponding logic to switch between them.
     */

    var streams = [],
        activeStream,
        protectionController,
        ownProtectionController = false,
        protectionData,
        STREAM_END_THRESHOLD = 0.2,
        autoPlay = true,
        canPlay = false,
        isStreamSwitchingInProgress = false,
        isUpdating = false,
        hasMediaError = false,
        mediaSource,
        UTCTimingSources,
        useManifestDateHeaderTimeSource,
        videoModel = null,
        playbackController,

        fireSwitchEvent = function(eventType, fromStream, toStream) {
            EventBus.trigger(eventType, {fromStreamInfo: fromStream ? fromStream.getStreamInfo() : null, toStreamInfo: toStream.getStreamInfo()})
        },

        startAutoPlay = function() {
            if (!activeStream.isActivated() || !canPlay) return;

            // only first stream must be played automatically during playback initialization
            if (activeStream.getStreamInfo().index === 0) {
                activeStream.startEventController();
                if (autoPlay) {
                    playbackController.start();
                }
            }
        },

        onCanPlay = function(/*e*/) {
            canPlay = true;
            startAutoPlay.call(this);
        },

        onPlaybackError = function (e) {
            var code = e.error ? e.error.code : 0,
                msg = "";

            if (code === -1) {
                // not an error!
                return;
            }

            switch (code) {
                case 1:
                    msg = "MEDIA_ERR_ABORTED";
                    break;
                case 2:
                    msg = "MEDIA_ERR_NETWORK";
                    break;
                case 3:
                    msg = "MEDIA_ERR_DECODE";
                    break;
                case 4:
                    msg = "MEDIA_ERR_SRC_NOT_SUPPORTED";
                    break;
                case 5:
                    msg = "MEDIA_ERR_ENCRYPTED";
                    break;
                default:
                    msg = "UNKNOWN";
                    break;
            }

            hasMediaError = true;

            this.log("Video Element Error: " + msg);
            if (e.error) {
                this.log(e.error);
            }
            this.errHandler.mediaSourceError(msg);
            this.reset();
        },

        /*
         * Called when current playback position is changed.
         * Used to determine the time current stream is finished and we should switch to the next stream.
         * TODO move to ???Extensions class
         */
        onPlaybackTimeUpdated = function(e) {
            var self = this,
                playbackQuality = self.videoExt.getPlaybackQuality(videoModel.getElement());

            if (playbackQuality) {
                self.metricsModel.addDroppedFrames("video", playbackQuality);
            }

            // Sometimes after seeking timeUpdateHandler is called before seekingHandler and a new stream starts
            // from beginning instead of from a chosen position. So we do nothing if the player is in the seeking state
            if (playbackController.isSeeking()) return;

            // check if stream end is reached
            if (e.timeToEnd < STREAM_END_THRESHOLD) {
                this.mediaSourceExt.signalEndOfStream(mediaSource);
            }
        },

        onEnded = function(/*e*/) {
            switchStream.call(this, activeStream, getNextStream());
        },

        /*
         * Called when Seeking event is occurred.
         * TODO move to ???Extensions class
         */
        onPlaybackSeeking = function(e) {
            var seekingStream = getStreamForTime(e.seekTime);

            if (seekingStream && seekingStream !== activeStream) {
                switchStream.call(this, activeStream, seekingStream, e.seekTime);
            }
        },

        /*
         * Handles the current stream buffering end moment to start the next stream buffering
         */
        onStreamBufferingCompleted = function(e) {
            var nextStream = getNextStream(),
                isLast = e.data.streamInfo.isLast;

            // buffering has been complted, now we can signal end of stream
            if (mediaSource && isLast) {
                this.mediaSourceExt.signalEndOfStream(mediaSource);
            }

            if (!nextStream) return;

            nextStream.activate(mediaSource);
        },

        getNextStream = function() {
            var start = activeStream.getStreamInfo().start,
                duration = activeStream.getStreamInfo().duration;

            return streams.filter(function(stream){
                return (stream.getStreamInfo().start === (start + duration));
            })[0];
        },

        getStreamForTime = function(time) {
            var duration = 0,
                stream = null,
                ln = streams.length;

            if (ln > 0) {
                duration += streams[0].getStartTime();
            }

            for (var i = 0; i < ln; i++) {
                stream = streams[i];
                duration += stream.getDuration();

                if (time < duration) {
                    return stream;
                }
            }

            return null;
        },

        switchStream = function(from, to, seekTo) {

            if(isStreamSwitchingInProgress || !from || !to || from === to) return;

            fireSwitchEvent.call(this, Events.PERIOD_SWITCH_STARTED, from, to);
            isStreamSwitchingInProgress = true;

            var self = this,
                onMediaSourceReady = function() {
                    if (seekTo !== undefined) {
                        playbackController.seek(seekTo);
                    }

                    playbackController.start();
                    activeStream.startEventController();
                    isStreamSwitchingInProgress = false;
                    fireSwitchEvent.call(self, Events.PERIOD_SWITCH_COMPLETED, from, to);
                };

            // TODO switchStream could be called from a handler of seeking event. from.deactivate() contains logic for
            // removing event listeners including that seeking event handler. Since dijon calls event listeners
            // synchronously an attempt to remove listener from itself leads to an exception in dijon lib. setTimeout is
            // used to workaround this issue.
            setTimeout(function() {
                from.deactivate();
                activeStream = to;
                playbackController.initialize(activeStream.getStreamInfo());
                setupMediaSource.call(self, onMediaSourceReady);
            }, 0);
        },

        setupMediaSource = function (callback) {
            var self = this,
                sourceUrl,

                onMediaSourceOpen = function (e) {
                    self.log("MediaSource is open!");
                    self.log(e);
                    window.URL.revokeObjectURL(sourceUrl);

                    mediaSource.removeEventListener("sourceopen", onMediaSourceOpen);
                    mediaSource.removeEventListener("webkitsourceopen", onMediaSourceOpen);

                    //self.log("MediaSource set up.");
                    setMediaDuration.call(self);

                    activeStream.activate(mediaSource);

                    if (callback) {
                        callback();
                    }
                };

            if (!mediaSource) {
                mediaSource = self.mediaSourceExt.createMediaSource();
                //self.log("MediaSource created.");
                //self.log("MediaSource should be closed. The actual readyState is: " + mediaSource.readyState);
            } else {
                self.mediaSourceExt.detachMediaSource(videoModel);
            }

            mediaSource.addEventListener("sourceopen", onMediaSourceOpen, false);
            mediaSource.addEventListener("webkitsourceopen", onMediaSourceOpen, false);
            sourceUrl = self.mediaSourceExt.attachMediaSource(mediaSource, videoModel);
            //self.log("MediaSource attached to video.  Waiting on open...");
        },

        setMediaDuration = function() {
            var self = this,
                manifestDuration,
                mediaDuration;

            manifestDuration = activeStream.getStreamInfo().manifestInfo.duration;
            mediaDuration = self.mediaSourceExt.setDuration(mediaSource, manifestDuration);
            self.log("Duration successfully set to: " + mediaDuration);
        },

        composeStreams = function() {
            var self = this,
                manifest = self.manifestModel.getValue(),
                metrics = self.metricsModel.getMetricsFor("stream"),
                manifestUpdateInfo = self.metricsExt.getCurrentManifestUpdate(metrics),
                streamInfo,
                pLen,
                sLen,
                pIdx,
                sIdx,
                streamsInfo,
                remainingStreams = [],
                stream;

            if (!manifest) return;

            streamsInfo = self.adapter.getStreamsInfo(manifest);

            if (this.capabilities.supportsEncryptedMedia()) {
                if (!protectionController) {
                    protectionController = this.system.getObject("protectionController");
                    EventBus.trigger(Events.PROTECTION_CREATED, {controller: protectionController, manifest: manifest});
                    ownProtectionController = true;
                }
                protectionController.setMediaElement(videoModel.getElement());
                if (protectionData) {
                    protectionController.setProtectionData(protectionData);
                }
            }

            try {
                if (streamsInfo.length === 0) {
                    throw new Error("There are no streams");
                }

                self.metricsModel.updateManifestUpdateInfo(manifestUpdateInfo, {currentTime: videoModel.getCurrentTime(),
                    buffered: videoModel.getElement().buffered, presentationStartTime: streamsInfo[0].start,
                    clientTimeOffset: self.timelineConverter.getClientTimeOffset()});

                isUpdating = true;

                for (pIdx = 0, pLen = streamsInfo.length; pIdx < pLen; pIdx += 1) {
                    streamInfo = streamsInfo[pIdx];
                    for (sIdx = 0, sLen = streams.length; sIdx < sLen; sIdx += 1) {
                        // If the stream already exists we just need to update the values we got from the updated manifest
                        if (streams[sIdx].getId() === streamInfo.id) {
                            stream = streams[sIdx];
                            remainingStreams.push(stream);
                            stream.updateData(streamInfo);
                        }
                    }
                    // If the Stream object does not exist we probably loaded the manifest the first time or it was
                    // introduced in the updated manifest, so we need to create a new Stream and perform all the initialization operations
                    if (!stream) {
                        stream = self.system.getObject("stream");
                        stream.initialize(streamInfo, protectionController, protectionData);
                        EventBus.on(Events.STREAM_INITIALIZED, onStreamInitialized, this);
                        remainingStreams.push(stream);

                        if (activeStream) {
                            stream.updateData(streamInfo);
                        }
                    }
                    self.metricsModel.addManifestUpdateStreamInfo(manifestUpdateInfo, streamInfo.id, streamInfo.index, streamInfo.start, streamInfo.duration);
                    stream = null;
                }

                streams = remainingStreams;

                // If the active stream has not been set up yet, let it be the first Stream in the list
                if (!activeStream) {
                    activeStream = streams[0];
                    fireSwitchEvent.call(self, Events.PERIOD_SWITCH_STARTED, null, activeStream);
                    playbackController.initialize(activeStream.getStreamInfo());
                    fireSwitchEvent.call(self, Events.PERIOD_SWITCH_COMPLETED, null, activeStream);
                }

                if (!mediaSource) {
                    setupMediaSource.call(this);
                }

                isUpdating = false;
                checkIfUpdateCompleted.call(self);
            } catch(e) {
                self.errHandler.manifestError(e.message, "nostreamscomposed", manifest);
                self.reset();
            }
        },

        checkIfUpdateCompleted = function() {
            if (isUpdating) return;

            var self = this,
                ln = streams.length,
                i = 0;

            startAutoPlay.call(this);

            for (i; i < ln; i += 1) {
                if (!streams[i].isInitialized()) return;
            }

            EventBus.trigger(Events.STREAMS_COMPOSED);
        },

        onStreamInitialized = function(/*e*/) {
            checkIfUpdateCompleted.call(this);
        },

        onTimeSyncCompleted = function (/*e*/) {
            composeStreams.call(this);
        },

        onManifestUpdated = function(e) {
            var self = this;
            if (!e.error) {
                //Since streams are not composed yet , need to manually look up useCalculatedLiveEdgeTime to detect if stream
                //is SegmentTimeline to avoid using time source
                var manifest = e.manifest,
                    streamInfo = self.adapter.getStreamsInfo(manifest)[0],
                    mediaInfo = (
                        self.adapter.getMediaInfoForType(manifest, streamInfo, "video") ||
                        self.adapter.getMediaInfoForType(manifest, streamInfo, "audio")
                    ),
                    adaptation,
                    useCalculatedLiveEdgeTime;

                if (mediaInfo) {
                    adaptation = self .adapter.getDataForMedia(mediaInfo);
                    useCalculatedLiveEdgeTime = self.manifestExt.getRepresentationsForAdaptation(manifest, adaptation)[0].useCalculatedLiveEdgeTime;

                    if (useCalculatedLiveEdgeTime) {
                        self .log("SegmentTimeline detected using calculated Live Edge Time");
                        useManifestDateHeaderTimeSource = false;
                    }
                }

                var manifestUTCTimingSources = self.manifestExt.getUTCTimingSources(e.manifest),
                    allUTCTimingSources = (!self.manifestExt.getIsDynamic(manifest) || useCalculatedLiveEdgeTime ) ?  manifestUTCTimingSources :  manifestUTCTimingSources.concat(UTCTimingSources),
                    isHTTPS = URIQueryAndFragmentModel.getInstance().isManifestHTTPS();
                    //If https is detected on manifest then lets apply that protocol to only the default time source(s). In the future we may find the need to apply this to more then just default so left code at this level instead of in MediaPlayer.
                    allUTCTimingSources.forEach(function(item){
                        if (item.value.replace(/.*?:\/\//g, "") === MediaPlayer.UTCTimingSources.default.value.replace(/.*?:\/\//g, "")){
                            item.value = item.value.replace(isHTTPS ? new RegExp(/^(http:)?\/\//i) : new RegExp(/^(https:)?\/\//i), isHTTPS ? "https://" : "http://");
                            self.log("Matching default timing source protocol to manifest protocol: " , item.value);
                        }
                    });

                self.timeSyncController.initialize(allUTCTimingSources, useManifestDateHeaderTimeSource);

            } else {
                self.reset();
            }
        };

    return {
        system: undefined,
        capabilities: undefined,
        manifestUpdater: undefined,
        manifestLoader: undefined,
        manifestModel: undefined,
        manifestExt: undefined,
        adapter: undefined,
        log: undefined,
        metricsModel: undefined,
        metricsExt: undefined,
        videoExt: undefined,
        liveEdgeFinder: undefined,
        mediaSourceExt: undefined,
        timelineConverter: undefined,
        protectionExt: undefined,
        timeSyncController: undefined,
        virtualBuffer: undefined,
        errHandler: undefined,

        getAutoPlay: function () {
            return autoPlay;
        },

        getActiveStreamInfo: function() {
            return activeStream ? activeStream.getStreamInfo() : null;
        },

        isStreamActive: function(streamInfo) {
            return (activeStream.getId() === streamInfo.id);
        },

        setUTCTimingSources: function(value, value2) {
            UTCTimingSources = value;
            useManifestDateHeaderTimeSource = value2;
        },

        /**
         * @param id
         * @returns {object}
         * @memberof StreamController#
         */
        getStreamById: function(id) {
            return streams.filter(function(item){
                return item.getId() === id;
            })[0];
        },

        initialize: function (autoPl, protCtrl, protData) {
            autoPlay = autoPl;
            protectionController = protCtrl;
            protectionData = protData;
            videoModel = VideoModel.getInstance();
            playbackController = PlaybackController.getInstance();
            playbackController.setConfig({
                streamController: this,
                log: this.log,
                timelineConverter: this.timelineConverter,
                metricsModel: this.metricsModel,
                metricsExt: this.metricsExt,
                manifestModel: this.manifestModel,
                manifestExt: this.manifestExt,
                adapter: this.adapter,
                videoModel: videoModel
            });
            EventBus.on(Events.TIME_SYNCHRONIZATION_COMPLETED, onTimeSyncCompleted, this);
            EventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, this);
            EventBus.on(Events.PLAYBACK_TIME_UPDATED, onPlaybackTimeUpdated, this);
            EventBus.on(Events.PLAYBACK_ENDED, onEnded, this);
            EventBus.on(Events.CAN_PLAY, onCanPlay, this);
            EventBus.on(Events.PLAYBACK_ERROR, onPlaybackError, this);
            EventBus.on(Events.MANIFEST_UPDATED, onManifestUpdated, this);
            EventBus.on(Events.STREAM_BUFFERING_COMPLETED, onStreamBufferingCompleted, this);
            this.timelineConverter.initialize();
            this.manifestLoader.initialize();
            this.manifestUpdater.initialize(this.manifestLoader);
        },

        load: function (url) {
            this.manifestLoader.load(url);
        },

        loadWithManifest: function (manifest) {
            this.manifestUpdater.setManifest(manifest);
        },

        reset: function () {

            var stream;
            this.timeSyncController.reset();

            for (var i = 0, ln = streams.length; i < ln; i++) {
                stream = streams[i];
                EventBus.off(Events.STREAM_INITIALIZED, onStreamInitialized, this);
                stream.reset(hasMediaError);
            }

            streams = [];

            EventBus.off(Events.PLAYBACK_TIME_UPDATED, onPlaybackTimeUpdated, this);
            EventBus.off(Events.PLAYBACK_SEEKING, onPlaybackSeeking, this);
            EventBus.off(Events.CAN_PLAY, onCanPlay, this);
            EventBus.off(Events.PLAYBACK_ERROR, onPlaybackError, this);
            EventBus.off(Events.PLAYBACK_ENDED, onEnded, this);
            EventBus.off(Events.STREAM_BUFFERING_COMPLETED, onStreamBufferingCompleted, this);
            EventBus.off(Events.MANIFEST_UPDATED, onManifestUpdated, this);
            this.manifestUpdater.reset();
            this.metricsModel.clearAllCurrentMetrics();


            var manifestUrl = (this.manifestModel.getValue()) ? this.manifestModel.getValue().url : null;
            this.manifestModel.setValue(null);
            this.manifestLoader.reset();

            this.timelineConverter.reset();
            this.liveEdgeFinder.reset();
            this.adapter.reset();
            this.virtualBuffer.reset();
            isStreamSwitchingInProgress = false;
            isUpdating = false;
            activeStream = null;
            canPlay = false;
            hasMediaError = false;

            if (mediaSource) {
                this.mediaSourceExt.detachMediaSource(videoModel);
                mediaSource = null;
            }

            videoModel = null;

            // Teardown the protection system, if necessary
            if (!protectionController) {
                EventBus.trigger(Events.STREAM_TEARDOWN_COMPLETE);
            }
            else if (ownProtectionController) {
                var self = this;
                var onTeardownComplete = function () {
                    EventBus.off(Events.TEARDOWN_COMPLETE, onTeardownComplete, self);
                    // Complete teardown process
                    ownProtectionController = false;
                    protectionController = null;
                    protectionData = null;
                    if (manifestUrl) {
                        EventBus.trigger(Events.PROTECTION_DESTROYED, {data: manifestUrl});
                    }
                    EventBus.trigger(Events.STREAM_TEARDOWN_COMPLETE);
                };
                EventBus.on(Events.TEARDOWN_COMPLETE, onTeardownComplete, this);
                protectionController.teardown();
            } else {
                protectionController.setMediaElement(null);
                protectionController = null;
                protectionData = null;
                EventBus.trigger(Events.STREAM_TEARDOWN_COMPLETE);
            }
        }
    };
};

StreamController.prototype = {
    constructor: StreamController
};

export default StreamController;