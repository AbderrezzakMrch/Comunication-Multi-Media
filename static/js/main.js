const menuToggle = document.getElementById('menuToggle');
const sidebar = document.getElementById('sidebar');
const uploadCTA = document.getElementById('uploadCTA');
const uploadModal = document.getElementById('uploadModal');
const uploadBackdrop = document.getElementById('uploadBackdrop');
const uploadClose = document.getElementById('uploadClose');
const uploadCancel = document.getElementById('uploadCancel');
const videoInput = document.getElementById('videoFile');
const videoFileLabel = document.getElementById('videoFileLabel');
const uploadForm = document.getElementById('uploadForm');
const adaptivePlayer = document.getElementById('adaptivePlayer');
const resolutionList = document.getElementById('resolutionList');
const segmentList = document.getElementById('segmentList');
const currentResolutionLabel = document.getElementById('currentResolutionLabel');
const currentSourceLabel = document.getElementById('currentSourceLabel');
const playerDataScript = document.getElementById('playerData');
const autoAdaptToggle = document.getElementById('autoAdaptToggle');

if(menuToggle && sidebar){
    menuToggle.addEventListener('click', () => {
        sidebar.classList.toggle('sidebar--open');
    });
}

function openUploadModal(){
    if(uploadModal){
        uploadModal.classList.add('modal--open');
        uploadModal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
    }
}

function closeUploadModal(){
    if(uploadModal){
        uploadModal.classList.remove('modal--open');
        uploadModal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }
}

if(uploadCTA){
    uploadCTA.addEventListener('click', () => {
        closeSidebarOnMobile();
        openUploadModal();
    });
}

if(uploadBackdrop){
    uploadBackdrop.addEventListener('click', closeUploadModal);
}

if(uploadClose){
    uploadClose.addEventListener('click', closeUploadModal);
}

if(uploadCancel){
    uploadCancel.addEventListener('click', closeUploadModal);
}

if(videoInput && videoFileLabel){
    videoInput.addEventListener('change', () => {
        if(videoInput.files && videoInput.files.length > 0){
            videoFileLabel.textContent = videoInput.files[0].name;
        } else {
            videoFileLabel.textContent = 'Choose a video file';
        }
    });
}

document.addEventListener('keydown', (event) => {
    if(event.key === 'Escape'){ 
        closeUploadModal();
    }
});

function closeSidebarOnMobile(){
    const isMobile = window.matchMedia('(max-width: 960px)').matches;
    if(isMobile && sidebar && sidebar.classList.contains('sidebar--open')){
        sidebar.classList.remove('sidebar--open');
    }
}

if(uploadForm){
    uploadForm.addEventListener('submit', (event) => {
        const selectedResolutions = uploadForm.querySelectorAll('input[name="resolutions"]:checked');
        if(selectedResolutions.length === 0){
            event.preventDefault();
            alert('Select at least one resolution to generate.');
            return;
        }

        const submitButton = uploadForm.querySelector('button[type="submit"]');
        if(submitButton){
            submitButton.disabled = true;
            submitButton.textContent = 'Processing...';
        }
    });
}

if(playerDataScript){
    try{
        const playerData = JSON.parse(playerDataScript.textContent);
        initialiseAdaptivePlayer(playerData);
    } catch(error){
        console.error('Failed to parse player data.', error);
    }
}

function initialiseAdaptivePlayer(playerData){
    if(!adaptivePlayer || !resolutionList || !segmentList){
        return;
    }

    const variants = Array.isArray(playerData.variants) ? playerData.variants : [];
    if(variants.length === 0){
        return;
    }

    const variantLabel = (variant) => variant.label || (variant.height ? `${variant.height}p` : 'Stream');
    const resolveVariantKey = (variant, index) => variant.key || `${variant.height || index}`;
    const segmentDurationSeconds = Number(playerData.segmentDuration) || 0;
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    const throughputHistory = [];
    let autoAdaptTimer = null;
    let consecutiveDowngrades = 0;
    let consecutiveUpgrades = 0;

    let currentVariant = variants.find((variant) => variant.isMaster) || variants[0];
    let currentSegmentIndex = 1;
    let currentSegmentSrc = currentVariant.file;
    let totalSegments = Array.isArray(currentVariant.segments) ? currentVariant.segments.length : 0;
    let isFullVideoMode = true;
    let pendingLoadedMetadataHandler = null;
    let suppressEnded = false;

    renderResolutionButtons();
    setVariant(currentVariant, { segmentIndex: currentSegmentIndex, resumeTime: 0, isFullVideo: true });
    adaptivePlayer.addEventListener('timeupdate', handleTimeUpdate);
    adaptivePlayer.addEventListener('ended', handleEnded);

    function renderResolutionButtons(){
        resolutionList.innerHTML = '';
        variants.forEach((variant, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip';
            const labelSpan = document.createElement('span');
            labelSpan.className = 'chip__label';
            labelSpan.textContent = variantLabel(variant);

            const hintSpan = document.createElement('span');
            hintSpan.className = 'chip__hint';
            const bandwidthText = formatBitrateHint(getVariantBitrate(variant));
            hintSpan.textContent = bandwidthText;

            button.appendChild(labelSpan);
            button.appendChild(hintSpan);
            const key = resolveVariantKey(variant, index);
            variant.__resolvedKey = key;
            button.dataset.key = key;
            button.dataset.variantIndex = String(index);
            button.addEventListener('click', () => {
                if(currentVariant.__resolvedKey === variant.__resolvedKey){
                    return;
                }
                const playbackContext = capturePlaybackContext();
                disableAutoAdapt();
                setVariant(variant, playbackContext);
            });
            resolutionList.appendChild(button);
        });
        updateActiveResolution();
    }

    function setVariant(nextVariant, playbackContext){
        currentVariant = nextVariant;
        if(!currentVariant.__resolvedKey){
            currentVariant.__resolvedKey = resolveVariantKey(currentVariant, variants.indexOf(currentVariant));
        }
        throughputHistory.length = 0;
        consecutiveDowngrades = 0;
        consecutiveUpgrades = 0;
        if(!playbackContext){
            playbackContext = { segmentIndex: 1, resumeTime: 0, isFullVideo: true };
        }
        updateActiveResolution();
        updateCurrentResolutionLabel();
        populateSegments(currentVariant);
        totalSegments = Array.isArray(currentVariant.segments) ? currentVariant.segments.length : 0;

        if(playbackContext.isFullVideo){
            playFullVideo(playbackContext.resumeTime, playbackContext.segmentIndex);
        } else if(!playSegmentByIndex(playbackContext.segmentIndex, playbackContext.resumeTime)){
            playFullVideo(playbackContext.resumeTime, playbackContext.segmentIndex);
        }
    }

    function populateSegments(variant){
        segmentList.innerHTML = '';
        segmentList.appendChild(createSegmentItem('full', 'Full video', variant.file));
        (variant.segments || []).forEach((segment) => {
            const label = segment.label || `Segment ${segment.index}`;
            segmentList.appendChild(createSegmentItem(segment.index, label, segment.url));
        });
    }

    function createSegmentItem(segmentIndex, label, sourceUrl){
        const listItem = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'segment-button';
        button.textContent = label;
        button.dataset.segmentIndex = String(segmentIndex);
        button.dataset.src = sourceUrl;
        button.addEventListener('click', () => {
            if(segmentIndex === 'full'){
                playFullVideo(0, 1);
            } else {
                const parsed = Number(segmentIndex);
                const targetIndex = Number.isNaN(parsed) ? segmentIndex : parsed;
                playSegmentByIndex(targetIndex, 0);
            }
        });
        listItem.appendChild(button);
        return listItem;
    }

    function capturePlaybackContext(){
        if(!adaptivePlayer){
            return { segmentIndex: currentSegmentIndex, resumeTime: 0, isFullVideo: isFullVideoMode };
        }
        const time = Number.isFinite(adaptivePlayer.currentTime) ? adaptivePlayer.currentTime : 0;
        const segmentIndexForResume = isFullVideoMode ? deriveSegmentIndex(null, time) : currentSegmentIndex;
        return { segmentIndex: segmentIndexForResume, resumeTime: time, isFullVideo: isFullVideoMode };
    }

    function playFullVideo(resumeTime, segmentIndexHint){
        isFullVideoMode = true;
        currentSegmentIndex = deriveSegmentIndex(segmentIndexHint, resumeTime);
        currentSegmentSrc = currentVariant.file;
        setVideoSource(
            currentVariant.file,
            `${variantLabel(currentVariant)} - full video`,
            resumeTime
        );
        return true;
    }

    function playSegmentByIndex(segmentIndex, resumeTime){
        const lookup = String(segmentIndex);
        const segments = currentVariant.segments || [];
        const target = segments.find((segment) => String(segment.index) === lookup);
        if(!target){
            return false;
        }
        isFullVideoMode = false;
        currentSegmentIndex = Number.isFinite(Number(target.index)) ? Number(target.index) : target.index;
        currentSegmentSrc = target.url;
        setVideoSource(
            target.url,
            `${variantLabel(currentVariant)} - ${target.label || `Segment ${target.index}`}`,
            resumeTime
        );
        return true;
    }

    function setVideoSource(sourceUrl, readableLabel, resumeTime){
        if(!adaptivePlayer){
            return;
        }

        const safeTime = Number.isFinite(resumeTime) && resumeTime > 0 ? resumeTime : 0;
        currentSegmentSrc = sourceUrl;

        if(currentSourceLabel){
            currentSourceLabel.textContent = readableLabel;
        }

        if(pendingLoadedMetadataHandler){
            adaptivePlayer.removeEventListener('loadedmetadata', pendingLoadedMetadataHandler);
            pendingLoadedMetadataHandler = null;
        }

        const handleLoadedMetadata = () => {
            adaptivePlayer.removeEventListener('loadedmetadata', handleLoadedMetadata);
            if(safeTime > 0){
                try{
                    adaptivePlayer.currentTime = safeTime;
                } catch(seekError){
                    console.warn('Unable to seek to resume time.', seekError);
                }
            }
            adaptivePlayer.play().catch(() => {});
            updateActiveSegment();
            suppressEnded = false;
        };

        pendingLoadedMetadataHandler = handleLoadedMetadata;
        adaptivePlayer.addEventListener('loadedmetadata', handleLoadedMetadata);

        suppressEnded = true;
        if(autoAdaptTimer){
            clearTimeout(autoAdaptTimer);
            autoAdaptTimer = null;
        }
        adaptivePlayer.pause();
        adaptivePlayer.src = sourceUrl;
        adaptivePlayer.load();
        updateActiveSegment();

        if(isAutoAdaptEnabled()){
            scheduleAutoAdaptCheck(sourceUrl);
        }
    }

    function updateActiveResolution(){
        const buttons = resolutionList.querySelectorAll('button');
        const activeKey = currentVariant.__resolvedKey || resolveVariantKey(currentVariant, variants.indexOf(currentVariant));
        buttons.forEach((button) => {
            const isActive = button.dataset.key === activeKey;
            button.classList.toggle('chip--active', isActive);
            button.classList.toggle('chip--auto-active', isActive && isAutoAdaptEnabled());

            const variantIndex = Number(button.dataset.variantIndex);
            const variantForButton = Number.isInteger(variantIndex) ? variants[variantIndex] : null;
            const hintNode = button.querySelector('.chip__hint');
            if(hintNode && variantForButton){
                const baseHint = formatBitrateHint(getVariantBitrate(variantForButton));
                if(isAutoAdaptEnabled() && isActive){
                    hintNode.textContent = `Auto · ${baseHint}`;
                } else {
                    hintNode.textContent = baseHint;
                }
            }
        });
    }

    function updateActiveSegment(){
        const buttons = segmentList.querySelectorAll('button');
        buttons.forEach((button) => {
            const buttonIndex = button.dataset.segmentIndex;
            const isFullButton = buttonIndex === 'full';
            let isActive = false;

            if(isFullVideoMode){
                const activeSegmentIndex = deriveSegmentIndex(null, adaptivePlayer ? adaptivePlayer.currentTime : 0);
                isActive = (!isFullButton && String(activeSegmentIndex) === buttonIndex) || (isFullButton && button.dataset.src === currentSegmentSrc);
            } else {
                isActive = String(currentSegmentIndex) === buttonIndex;
            }

            button.classList.toggle('segment-button--active', isActive);
        });
    }

    function deriveSegmentIndex(segmentIndexHint, resumeTime){
        if(totalSegments === 0){
            return 1;
        }

        if(Number.isFinite(segmentIndexHint) && segmentIndexHint >= 1 && segmentIndexHint <= totalSegments){
            return Math.floor(segmentIndexHint);
        }

        const time = Number.isFinite(resumeTime) ? resumeTime : 0;
        if(segmentDurationSeconds <= 0){
            return 1;
        }

        const computedIndex = Math.floor(time / segmentDurationSeconds) + 1;
        return Math.min(Math.max(computedIndex, 1), totalSegments);
    }

    function handleTimeUpdate(){
        if(!isFullVideoMode || totalSegments === 0 || segmentDurationSeconds <= 0){
            return;
        }
        const time = Number.isFinite(adaptivePlayer.currentTime) ? adaptivePlayer.currentTime : 0;
        const nextIndex = deriveSegmentIndex(null, time);
        if(nextIndex !== currentSegmentIndex){
            currentSegmentIndex = nextIndex;
            updateActiveSegment();
        }
    }

    function handleEnded(){
        if(suppressEnded){
            return;
        }

        if(isFullVideoMode){
            return;
        }

        const nextIndex = Number.isFinite(Number(currentSegmentIndex)) ? Number(currentSegmentIndex) + 1 : null;
        if(nextIndex && nextIndex <= totalSegments){
            playSegmentByIndex(nextIndex, 0);
        }
    }

    function scheduleAutoAdaptCheck(sourceUrl){
        if(autoAdaptTimer){
            clearTimeout(autoAdaptTimer);
        }
        const absoluteUrl = normaliseUrl(sourceUrl);
        autoAdaptTimer = window.setTimeout(() => {
            maybeAutoAdapt(absoluteUrl);
        }, 1200);
    }

    function maybeAutoAdapt(resourceUrl){
        const measuredThroughput = measureThroughputKbps(resourceUrl);
        const fallbackThroughput = connection && typeof connection.downlink === 'number' ? connection.downlink * 1000 : null;
        const throughputKbps = measuredThroughput || fallbackThroughput;

        if(!isAutoAdaptEnabled() || !throughputKbps || !currentVariant){
            rescheduleAutoAdapt();
            return;
        }

        throughputHistory.push(throughputKbps);
        if(throughputHistory.length > 5){
            throughputHistory.shift();
        }

    const averageThroughput = throughputHistory.reduce((sum, value) => sum + value, 0) / throughputHistory.length;
    const currentBitrate = getVariantBitrate(currentVariant);
        const headroomRatio = 0.85;

        if(currentBitrate > 0 && averageThroughput < currentBitrate * 1.15){
            consecutiveDowngrades += 1;
            consecutiveUpgrades = 0;
            const downgradeCandidate = findLowerVariant(currentVariant);
            if(downgradeCandidate && consecutiveDowngrades >= 2){
                const context = capturePlaybackContext();
                throughputHistory.length = 0;
                consecutiveDowngrades = 0;
                setVariant(downgradeCandidate, context);
                return;
            }
            rescheduleAutoAdapt();
            return;
        }

        consecutiveDowngrades = 0;
    const upgradeCandidate = selectVariantForThroughput(averageThroughput * headroomRatio);
        if(upgradeCandidate && upgradeCandidate.__resolvedKey !== currentVariant.__resolvedKey){
            consecutiveUpgrades += 1;
            if(consecutiveUpgrades >= 3){
                const context = capturePlaybackContext();
                throughputHistory.length = 0;
                consecutiveUpgrades = 0;
                setVariant(upgradeCandidate, context);
                return;
            }
        } else {
            consecutiveUpgrades = 0;
        }
        rescheduleAutoAdapt();
    }

    function measureThroughputKbps(resourceUrl){
        try{
            const entries = performance.getEntriesByName(resourceUrl);
            if(!entries || entries.length === 0){
                return null;
            }
            const entry = entries[entries.length - 1];
            const transferBytes = entry.transferSize || entry.encodedBodySize || entry.decodedBodySize;
            const durationMs = entry.responseEnd - entry.requestStart;
            if(!transferBytes || transferBytes <= 0 || !durationMs || durationMs <= 0){
                return null;
            }
            const bits = transferBytes * 8;
            const seconds = durationMs / 1000;
            return (bits / seconds) / 1000;
        } catch(error){
            return null;
        } finally {
            trimResourceTimings();
        }
    }

    function selectVariantForThroughput(throughputKbps){
        if(!throughputKbps){
            return null;
        }
        let candidate = null;
        variants.forEach((variant, index) => {
            if(!variant.__resolvedKey){
                variant.__resolvedKey = resolveVariantKey(variant, index);
            }
            const bitrate = getVariantBitrate(variant);
            if(bitrate && bitrate <= throughputKbps){
                if(!candidate || bitrate > getVariantBitrate(candidate)){
                    candidate = variant;
                }
            }
        });
        if(!candidate){
            return null;
        }
        const candidateBitrate = getVariantBitrate(candidate);
        const currentBitrate = getVariantBitrate(currentVariant);
        if(candidateBitrate === 0 || candidateBitrate <= currentBitrate){
            return null;
        }
        return candidate;
    }

    function findLowerVariant(referenceVariant){
        const referenceKey = referenceVariant.__resolvedKey;
        const referenceIndex = variants.findIndex((variant) => variant.__resolvedKey === referenceKey);
        if(referenceIndex === -1){
            return null;
        }
        for(let index = referenceIndex + 1; index < variants.length; index += 1){
            const candidate = variants[index];
            if(candidate){
                if(!candidate.__resolvedKey){
                    candidate.__resolvedKey = resolveVariantKey(candidate, index);
                }
                return candidate;
            }
        }
        return null;
    }

    function trimResourceTimings(){
        const entries = performance.getEntriesByType('resource');
        if(entries && entries.length > 200){
            performance.clearResourceTimings();
        }
    }

    function normaliseUrl(url){
        try{
            return new URL(url, window.location.href).href;
        } catch(error){
            return url;
        }
    }

    function rescheduleAutoAdapt(){
        if(!isAutoAdaptEnabled()){
            return;
        }
        if(autoAdaptTimer){
            clearTimeout(autoAdaptTimer);
        }
        autoAdaptTimer = window.setTimeout(() => {
            maybeAutoAdapt(normaliseUrl(currentSegmentSrc));
        }, 4000);
    }

    function getVariantBitrate(variant){
        if(!variant){
            return 0;
        }
        if(variant.bitrateKbps && variant.bitrateKbps > 0){
            return variant.bitrateKbps;
        }
        const inferredHeight = inferHeightFromVariant(variant);
        if(!inferredHeight){
            return 1500;
        }
        if(inferredHeight >= 2160){
            return 14000;
        }
        if(inferredHeight >= 1440){
            return 9000;
        }
        if(inferredHeight >= 1080){
            return 6000;
        }
        if(inferredHeight >= 720){
            return 3500;
        }
        if(inferredHeight >= 480){
            return 1800;
        }
        return 900;
    }

    function inferHeightFromVariant(variant){
        if(variant.height){
            return Number(variant.height);
        }
        if(typeof variant.label === 'string'){
            const match = variant.label.match(/(\d{3,4})p/i);
            if(match){
                return Number(match[1]);
            }
        }
        return null;
    }

    function isAutoAdaptEnabled(){
        return autoAdaptToggle ? autoAdaptToggle.checked : false;
    }

    function disableAutoAdapt(){
        if(autoAdaptToggle){
            autoAdaptToggle.checked = false;
        }
        if(autoAdaptTimer){
            clearTimeout(autoAdaptTimer);
            autoAdaptTimer = null;
        }
        updateCurrentResolutionLabel();
    }

    if(autoAdaptToggle){
        autoAdaptToggle.addEventListener('change', () => {
            throughputHistory.length = 0;
            consecutiveDowngrades = 0;
            consecutiveUpgrades = 0;
            if(autoAdaptToggle.checked){
                rescheduleAutoAdapt();
            } else if(autoAdaptTimer){
                clearTimeout(autoAdaptTimer);
                autoAdaptTimer = null;
            }
            updateActiveResolution();
            updateCurrentResolutionLabel();
        });
    }

    function formatBitrateHint(bitrateKbps){
        if(!bitrateKbps || !Number.isFinite(bitrateKbps)){
            return 'Auto';
        }
        const mbps = bitrateKbps / 1000;
        if(mbps >= 1){
            return `${mbps.toFixed(1)} Mbps+`;
        }
        return `${Math.ceil(bitrateKbps)} kbps+`;
    }

    function updateCurrentResolutionLabel(){
        if(!currentResolutionLabel){
            return;
        }
        const baseLabel = variantLabel(currentVariant);
        if(isAutoAdaptEnabled()){
            currentResolutionLabel.textContent = `Auto · ${baseLabel}`;
        } else {
            currentResolutionLabel.textContent = baseLabel;
        }
    }
}
