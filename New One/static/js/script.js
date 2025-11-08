// Common functions for all pages
document.addEventListener('DOMContentLoaded', function() {
    // Initialize video selectors on pages that have them
    const videoSelect = document.getElementById('videoSelect');
    if (videoSelect) {
        loadVideos();
    }
    
    // Set up file upload
    const videoInput = document.getElementById('videoInput');
    if (videoInput) {
        videoInput.addEventListener('change', handleVideoUpload);
    }
});

// Load available videos for selection
async function loadVideos() {
    try {
        const response = await fetch('/videos');
        const videos = await response.json();
        
        const videoSelect = document.getElementById('videoSelect');
        videoSelect.innerHTML = '<option value="">-- Select a video --</option>';
        
        for (const [id, video] of Object.entries(videos)) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = video.filename;
            videoSelect.appendChild(option);
        }
        
        // Set up video selection change event
        videoSelect.addEventListener('change', function() {
            const selectedId = this.value;
            if (selectedId && videos[selectedId]) {
                displayVideoInfo(videos[selectedId]);
            } else {
                hideVideoInfo();
            }
        });
    } catch (error) {
        console.error('Error loading videos:', error);
    }
}

// Display video information
function displayVideoInfo(video) {
    const videoInfo = document.getElementById('videoInfo');
    const videoName = document.getElementById('videoName');
    const videoDuration = document.getElementById('videoDuration');
    
    if (videoInfo && videoName && videoDuration) {
        videoName.textContent = `Filename: ${video.filename}`;
        videoDuration.textContent = `Duration: ${Math.round(video.duration)} seconds`;
        videoInfo.style.display = 'block';
    }
}

// Hide video information
function hideVideoInfo() {
    const videoInfo = document.getElementById('videoInfo');
    if (videoInfo) {
        videoInfo.style.display = 'none';
    }
}

// Handle video upload
async function handleVideoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('video', file);
    
    const progressContainer = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const resultContainer = document.getElementById('uploadResult');
    
    // Show progress
    progressContainer.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = 'Uploading...';
    
    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            progressFill.style.width = '100%';
            progressText.textContent = 'Upload complete!';
            
            // Show success message
            resultContainer.innerHTML = `
                <div class="success">
                    <h3>Upload Successful!</h3>
                    <p>Video: ${result.filename}</p>
                    <p>Duration: ${Math.round(result.duration)} seconds</p>
                    <p>Video ID: ${result.video_id}</p>
                </div>
            `;
            resultContainer.style.display = 'block';
            
            // Reload videos list if on a page with selector
            if (document.getElementById('videoSelect')) {
                loadVideos();
            }
        } else {
            throw new Error(result.error || 'Upload failed');
        }
    } catch (error) {
        console.error('Upload error:', error);
        progressContainer.style.display = 'none';
        
        // Show error message
        resultContainer.innerHTML = `
            <div class="error">
                <h3>Upload Failed</h3>
                <p>${error.message}</p>
            </div>
        `;
        resultContainer.style.display = 'block';
    }
}

// Segment video
async function segmentVideo() {
    const videoSelect = document.getElementById('videoSelect');
    const segmentCount = document.getElementById('segmentCount');
    const resultContainer = document.getElementById('segmentResult');
    
    if (!videoSelect.value) {
        alert('Please select a video first');
        return;
    }
    
    const videoId = videoSelect.value;
    const numSegments = parseInt(segmentCount.value) || 6;
    
    try {
        const response = await fetch('/segment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                video_id: videoId,
                num_segments: numSegments
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultContainer.innerHTML = `
                <div class="success">
                    <h3>Segmentation Successful!</h3>
                    <p>Created ${Object.keys(result.segments).length} segments</p>
                </div>
            `;
        } else {
            throw new Error(result.error || 'Segmentation failed');
        }
    } catch (error) {
        console.error('Segmentation error:', error);
        resultContainer.innerHTML = `
            <div class="error">
                <h3>Segmentation Failed</h3>
                <p>${error.message}</p>
            </div>
        `;
    }
    
    resultContainer.style.display = 'block';
}

// Create multiple resolutions
async function createResolutions() {
    const videoSelect = document.getElementById('videoSelect');
    const resultContainer = document.getElementById('resolutionResult');
    
    if (!videoSelect.value) {
        alert('Please select a video first');
        return;
    }
    
    const videoId = videoSelect.value;
    
    try {
        const response = await fetch('/resolution', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                video_id: videoId
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultContainer.innerHTML = `
                <div class="success">
                    <h3>Resolutions Created Successfully!</h3>
                    <p>Generated ${Object.keys(result.resolutions).length} resolutions</p>
                </div>
            `;
        } else {
            throw new Error(result.error || 'Resolution creation failed');
        }
    } catch (error) {
        console.error('Resolution creation error:', error);
        resultContainer.innerHTML = `
            <div class="error">
                <h3>Resolution Creation Failed</h3>
                <p>${error.message}</p>
            </div>
        `;
    }
    
    resultContainer.style.display = 'block';
}

// Video player functionality
function setupVideoPlayer() {
    const videoSelect = document.getElementById('videoSelect');
    const resolutionSelect = document.getElementById('resolutionSelect');
    const videoPlayer = document.getElementById('videoPlayer');
    const currentSegment = document.getElementById('currentSegment');
    const totalSegments = document.getElementById('totalSegments');
    
    if (!videoSelect || !resolutionSelect || !videoPlayer) return;
    
    let currentVideoId = null;
    let currentResolution = 'original';
    let segments = {};
    
    // Load videos for player
    loadVideos().then(() => {
        videoSelect.addEventListener('change', function() {
            currentVideoId = this.value;
            if (currentVideoId) {
                loadVideoSegments(currentVideoId);
            }
        });
        
        resolutionSelect.addEventListener('change', function() {
            currentResolution = this.value;
            if (currentVideoId) {
                updateVideoSource();
            }
        });
    });
    
    // Load video segments
    async function loadVideoSegments(videoId) {
        try {
            const response = await fetch('/videos');
            const videos = await response.json();
            
            if (videos[videoId] && videos[videoId].segments) {
                segments = videos[videoId].segments;
                totalSegments.textContent = Object.keys(segments).length;
                
                // Load first segment
                updateVideoSource();
            } else {
                alert('No segments found for this video. Please segment it first.');
            }
        } catch (error) {
            console.error('Error loading segments:', error);
        }
    }
    
    // Update video source based on current segment and resolution
    function updateVideoSource(segmentNum = 1) {
        if (!currentVideoId || !segments[segmentNum]) return;
        
        const segmentUrl = `/playlist/${currentVideoId}/${currentResolution}/${segmentNum}`;
        videoPlayer.src = segmentUrl;
        currentSegment.textContent = segmentNum;
        
        // Set up event to load next segment when current one ends
        videoPlayer.onended = function() {
            const nextSegment = parseInt(segmentNum) + 1;
            if (segments[nextSegment]) {
                updateVideoSource(nextSegment);
            }
        };
    }
}

// Initialize video player if on player page
if (window.location.pathname === '/player' || window.location.pathname.includes('player.html')) {
    document.addEventListener('DOMContentLoaded', setupVideoPlayer);
}

// Add this function to refresh video displays
function refreshVideoDisplays() {
    // Reload the page to show updated videos/segments
    setTimeout(() => {
        window.location.reload();
    }, 2000);
}

// Update the segmentVideo function
async function segmentVideo() {
    const videoSelect = document.getElementById('videoSelect');
    const segmentCount = document.getElementById('segmentCount');
    const resultContainer = document.getElementById('segmentResult');
    
    if (!videoSelect.value) {
        alert('Please select a video first');
        return;
    }
    
    const videoId = videoSelect.value;
    const numSegments = parseInt(segmentCount.value) || 6;
    
    try {
        const response = await fetch('/segment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                video_id: videoId,
                num_segments: numSegments
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultContainer.innerHTML = `
                <div class="success">
                    <h3>Segmentation Successful!</h3>
                    <p>Created ${Object.keys(result.segments).length} segments</p>
                </div>
            `;
            refreshVideoDisplays();
        } else {
            throw new Error(result.error || 'Segmentation failed');
        }
    } catch (error) {
        console.error('Segmentation error:', error);
        resultContainer.innerHTML = `
            <div class="error">
                <h3>Segmentation Failed</h3>
                <p>${error.message}</p>
            </div>
        `;
    }
    
    resultContainer.style.display = 'block';
}

// Update the createResolutions function
async function createResolutions() {
    const videoSelect = document.getElementById('videoSelect');
    const resultContainer = document.getElementById('resolutionResult');
    
    if (!videoSelect.value) {
        alert('Please select a video first');
        return;
    }
    
    const videoId = videoSelect.value;
    
    try {
        const response = await fetch('/resolution', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                video_id: videoId
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultContainer.innerHTML = `
                <div class="success">
                    <h3>Resolutions Created Successfully!</h3>
                    <p>Generated ${Object.keys(result.resolutions).length} resolutions</p>
                </div>
            `;
            refreshVideoDisplays();
        } else {
            throw new Error(result.error || 'Resolution creation failed');
        }
    } catch (error) {
        console.error('Resolution creation error:', error);
        resultContainer.innerHTML = `
            <div class="error">
                <h3>Resolution Creation Failed</h3>
                <p>${error.message}</p>
            </div>
        `;
    }
    
    resultContainer.style.display = 'block';
}
// Segment all resolutions
async function segmentAllResolutions() {
    const videoSelect = document.getElementById('videoSelect');
    const resultContainer = document.getElementById('resolutionResult');
    
    if (!videoSelect.value) {
        alert('Please select a video first');
        return;
    }
    
    const videoId = videoSelect.value;
    
    try {
        const response = await fetch('/segment_resolutions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                video_id: videoId
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultContainer.innerHTML = `
                <div class="success">
                    <h3>All Resolutions Segmented Successfully!</h3>
                    <p>Created segments for ${Object.keys(result.resolution_segments).length} resolutions</p>
                </div>
            `;
            refreshVideoDisplays();
        } else {
            throw new Error(result.error || 'Resolution segmentation failed');
        }
    } catch (error) {
        console.error('Resolution segmentation error:', error);
        resultContainer.innerHTML = `
            <div class="error">
                <h3>Resolution Segmentation Failed</h3>
                <p>${error.message}</p>
            </div>
        `;
    }
    
    resultContainer.style.display = 'block';
}

// Segment all resolutions
async function segmentAllResolutions() {
    const videoSelect = document.getElementById('videoSelect');
    const resultContainer = document.getElementById('resolutionResult');
    
    if (!videoSelect.value) {
        alert('Please select a video first');
        return;
    }
    
    const videoId = videoSelect.value;
    
    try {
        const response = await fetch('/segment_resolutions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                video_id: videoId
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultContainer.innerHTML = `
                <div class="success">
                    <h3>All Resolutions Segmented Successfully!</h3>
                    <p>Created segments for ${Object.keys(result.resolution_segments).length} resolutions</p>
                </div>
            `;
            refreshVideoDisplays();
        } else {
            throw new Error(result.error || 'Resolution segmentation failed');
        }
    } catch (error) {
        console.error('Resolution segmentation error:', error);
        resultContainer.innerHTML = `
            <div class="error">
                <h3>Resolution Segmentation Failed</h3>
                <p>${error.message}</p>
            </div>
        `;
    }
    
    resultContainer.style.display = 'block';
}

// Enhanced video player with quality switching
function setupVideoPlayer() {
    const videoSelect = document.getElementById('videoSelect');
    const resolutionSelect = document.getElementById('resolutionSelect');
    const videoPlayer = document.getElementById('videoPlayer');
    const currentSegment = document.getElementById('currentSegment');
    const totalSegments = document.getElementById('totalSegments');
    const currentResolution = document.getElementById('currentResolution');
    const bufferStatus = document.getElementById('bufferStatus');
    const segmentButtons = document.getElementById('segmentButtons');
    
    if (!videoSelect || !resolutionSelect || !videoPlayer) return;
    
    let currentVideoId = null;
    let currentRes = 'original';
    let segments = {};
    let totalSegmentCount = 0;
    
    // Load videos for player
    loadVideos().then(() => {
        videoSelect.addEventListener('change', function() {
            currentVideoId = this.value;
            if (currentVideoId) {
                loadVideoData(currentVideoId);
            }
        });
        
        resolutionSelect.addEventListener('change', function() {
            if (currentVideoId) {
                switchResolution(this.value);
            }
        });
        
        // Monitor buffer status
        videoPlayer.addEventListener('progress', updateBufferStatus);
        videoPlayer.addEventListener('timeupdate', updateSegmentInfo);
    });
    
    // Load video data
    async function loadVideoData(videoId) {
        try {
            const response = await fetch('/videos');
            const videos = await response.json();
            
            if (videos[videoId] && videos[videoId].resolution_segments) {
                segments = videos[videoId].resolution_segments;
                totalSegmentCount = videos[videoId].segment_count || 0;
                
                // Update UI
                totalSegments.textContent = totalSegmentCount;
                currentResolution.textContent = currentRes.toUpperCase();
                
                // Create segment buttons
                createSegmentButtons(totalSegmentCount);
                
                // Load first segment
                loadSegment(1);
            } else {
                alert('This video is not fully processed. Please complete all steps in the pipeline.');
            }
        } catch (error) {
            console.error('Error loading video data:', error);
        }
    }
    
    // Switch resolution
    function switchResolution(newResolution) {
        currentRes = newResolution;
        currentResolution.textContent = currentRes.toUpperCase();
        
        // Reload current segment with new resolution
        const currentSeg = parseInt(currentSegment.textContent) || 1;
        loadSegment(currentSeg);
    }
    
    // Load specific segment
    function loadSegment(segmentNum) {
        if (!currentVideoId || !segments[currentRes] || !segments[currentRes][segmentNum]) {
            console.error('Segment not available:', currentRes, segmentNum);
            return;
        }
        
        const segmentUrl = `/playlist/${currentVideoId}/${currentRes}/${segmentNum}`;
        videoPlayer.src = segmentUrl;
        currentSegment.textContent = segmentNum;
        
        // Update active segment button
        updateSegmentButtons(segmentNum);
        
        // Set up event to load next segment when current one ends
        videoPlayer.onended = function() {
            const nextSegment = parseInt(segmentNum) + 1;
            if (nextSegment <= totalSegmentCount) {
                loadSegment(nextSegment);
            }
        };
        
        // Play the segment
        videoPlayer.play().catch(e => console.log('Autoplay prevented:', e));
    }
    
    // Create segment navigation buttons
    function createSegmentButtons(count) {
        segmentButtons.innerHTML = '';
        for (let i = 1; i <= count; i++) {
            const button = document.createElement('button');
            button.className = 'segment-button';
            button.textContent = `Segment ${i}`;
            button.onclick = () => loadSegment(i);
            segmentButtons.appendChild(button);
        }
    }
    
    // Update active segment button
    function updateSegmentButtons(activeSegment) {
        const buttons = segmentButtons.getElementsByClassName('segment-button');
        for (let i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('active', (i + 1) === activeSegment);
        }
    }
    
    // Update buffer status
    function updateBufferStatus() {
        if (videoPlayer.buffered.length > 0) {
            const bufferedEnd = videoPlayer.buffered.end(videoPlayer.buffered.length - 1);
            const duration = videoPlayer.duration;
            const bufferedPercent = (bufferedEnd / duration) * 100;
            bufferStatus.textContent = `${Math.round(bufferedPercent)}% buffered`;
        }
    }
    
    // Update segment information
    function updateSegmentInfo() {
        // You can add more real-time info here if needed
    }
}

// Initialize video player if on player page
if (window.location.pathname === '/player' || window.location.pathname.includes('player.html')) {
    document.addEventListener('DOMContentLoaded', setupVideoPlayer);
}
// Enhanced video player with dynamic resolution selection
function setupVideoPlayer() {
    const videoSelect = document.getElementById('videoSelect');
    const resolutionSelect = document.getElementById('resolutionSelect');
    const videoPlayer = document.getElementById('videoPlayer');
    const currentSegment = document.getElementById('currentSegment');
    const totalSegments = document.getElementById('totalSegments');
    const currentResolution = document.getElementById('currentResolution');
    const bufferStatus = document.getElementById('bufferStatus');
    const segmentButtons = document.getElementById('segmentButtons');
    
    if (!videoSelect || !resolutionSelect || !videoPlayer) return;
    
    let currentVideoId = null;
    let currentRes = 'original';
    let segments = {};
    let totalSegmentCount = 0;
    let availableResolutions = [];
    
    // Load videos for player
    loadVideos().then(() => {
        videoSelect.addEventListener('change', function() {
            currentVideoId = this.value;
            if (currentVideoId) {
                loadVideoData(currentVideoId);
            } else {
                clearPlayer();
            }
        });
        
        resolutionSelect.addEventListener('change', function() {
            if (currentVideoId && this.value) {
                switchResolution(this.value);
            }
        });
        
        // Monitor buffer status
        videoPlayer.addEventListener('progress', updateBufferStatus);
        videoPlayer.addEventListener('timeupdate', updateSegmentInfo);
    });
    
    // Load video data
    async function loadVideoData(videoId) {
        try {
            const response = await fetch('/videos');
            const videos = await response.json();
            
            if (videos[videoId]) {
                const video = videos[videoId];
                
                // Get available resolutions
                availableResolutions = getAvailableResolutions(video);
                updateResolutionSelector(availableResolutions);
                
                if (video.resolution_segments) {
                    segments = video.resolution_segments;
                    totalSegmentCount = video.segment_count || 0;
                    
                    // Update UI
                    totalSegments.textContent = totalSegmentCount;
                    
                    // Create segment buttons
                    createSegmentButtons(totalSegmentCount);
                    
                    // Load first segment
                    loadSegment(1);
                } else {
                    alert('This video is not fully processed. Please complete segmentation steps first.');
                    clearPlayer();
                }
            }
        } catch (error) {
            console.error('Error loading video data:', error);
        }
    }
    
    // Get available resolutions for a video
    function getAvailableResolutions(video) {
        const resolutions = [];
        
        // Always include original if available
        if (video.original_segments && Object.keys(video.original_segments).length > 0) {
            resolutions.push({
                value: 'original',
                label: `Original${video.original_resolution ? ` (${video.original_resolution})` : ''}`
            });
        }
        
        // Add generated resolutions
        if (video.resolution_segments) {
            Object.keys(video.resolution_segments).forEach(res => {
                if (res !== 'original' && video.resolution_segments[res] && Object.keys(video.resolution_segments[res]).length > 0) {
                    resolutions.push({
                        value: res,
                        label: res.toUpperCase()
                    });
                }
            });
        }
        
        return resolutions;
    }
    
    // Update resolution selector with available options
    function updateResolutionSelector(resolutions) {
        resolutionSelect.innerHTML = '';
        
        if (resolutions.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No resolutions available';
            resolutionSelect.appendChild(option);
            return;
        }
        
        resolutions.forEach(res => {
            const option = document.createElement('option');
            option.value = res.value;
            option.textContent = res.label;
            resolutionSelect.appendChild(option);
        });
        
        // Set default resolution
        currentRes = resolutions[0].value;
        currentResolution.textContent = resolutions[0].label;
    }
    
    // Switch resolution
    function switchResolution(newResolution) {
        currentRes = newResolution;
        const selectedOption = resolutionSelect.options[resolutionSelect.selectedIndex];
        currentResolution.textContent = selectedOption.textContent;
        
        // Reload current segment with new resolution
        const currentSeg = parseInt(currentSegment.textContent) || 1;
        loadSegment(currentSeg);
    }
    
    // Load specific segment
    function loadSegment(segmentNum) {
        if (!currentVideoId || !segments[currentRes] || !segments[currentRes][segmentNum]) {
            console.error('Segment not available:', currentRes, segmentNum);
            showError('Segment not available for selected quality');
            return;
        }
        
        const segmentUrl = `/segment/${currentVideoId}/${currentRes}/${segmentNum}`;
        
        // Show loading state
        videoPlayer.poster = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 100 100"><rect width="100%" height="100%" fill="%23f0f0f0"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="12" fill="%23999">Loading segment...</text></svg>';
        
        videoPlayer.src = segmentUrl;
        currentSegment.textContent = segmentNum;
        
        // Update active segment button
        updateSegmentButtons(segmentNum);
        
        // Set up event to load next segment when current one ends
        videoPlayer.onended = function() {
            const nextSegment = parseInt(segmentNum) + 1;
            if (nextSegment <= totalSegmentCount) {
                loadSegment(nextSegment);
            }
        };
        
        // Play the segment
        videoPlayer.load();
        videoPlayer.play().catch(e => {
            console.log('Autoplay prevented:', e);
        });
    }
    
    // Create segment navigation buttons
    function createSegmentButtons(count) {
        segmentButtons.innerHTML = '';
        for (let i = 1; i <= count; i++) {
            const button = document.createElement('button');
            button.className = 'segment-button';
            button.textContent = `Segment ${i}`;
            button.onclick = () => loadSegment(i);
            segmentButtons.appendChild(button);
        }
    }
    
    // Update active segment button
    function updateSegmentButtons(activeSegment) {
        const buttons = segmentButtons.getElementsByClassName('segment-button');
        for (let i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('active', (i + 1) === activeSegment);
        }
    }
    
    // Update buffer status
    function updateBufferStatus() {
        if (videoPlayer.buffered.length > 0 && videoPlayer.duration > 0) {
            const bufferedEnd = videoPlayer.buffered.end(videoPlayer.buffered.length - 1);
            const bufferedPercent = (bufferedEnd / videoPlayer.duration) * 100;
            bufferStatus.textContent = `${Math.round(bufferedPercent)}% buffered`;
        } else {
            bufferStatus.textContent = '0% buffered';
        }
    }
    
    // Update segment information
    function updateSegmentInfo() {
        // Additional segment info can be added here
    }
    
    // Show error message
    function showError(message) {
        videoPlayer.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; background: #f8f9fa;">
                <div style="text-align: center; color: #666;">
                    <h3>⚠️ Playback Error</h3>
                    <p>${message}</p>
                </div>
            </div>
        `;
    }
    
    // Clear player
    function clearPlayer() {
        videoPlayer.src = '';
        currentSegment.textContent = '-';
        totalSegments.textContent = '-';
        currentResolution.textContent = '-';
        bufferStatus.textContent = '-';
        segmentButtons.innerHTML = '';
        resolutionSelect.innerHTML = '<option value="">Select quality</option>';
    }
}

// Initialize video player if on player page
if (window.location.pathname === '/player' || window.location.pathname.includes('player.html')) {
    document.addEventListener('DOMContentLoaded', setupVideoPlayer);
}