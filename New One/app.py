import os
import json
import subprocess
from flask import Flask, render_template, request, jsonify, send_file
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key'
app.config['UPLOAD_FOLDER'] = 'uploads/videos'
app.config['SEGMENT_FOLDER'] = 'uploads/segments'
app.config['PLAYLIST_FOLDER'] = 'uploads/playlists'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB max file size

# Create directories if they don't exist
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs(app.config['SEGMENT_FOLDER'], exist_ok=True)
os.makedirs(app.config['PLAYLIST_FOLDER'], exist_ok=True)

# Store video metadata
VIDEOS_FILE = 'videos.json'

def load_videos():
    if os.path.exists(VIDEOS_FILE):
        with open(VIDEOS_FILE, 'r') as f:
            return json.load(f)
    return {}

def save_videos(videos):
    with open(VIDEOS_FILE, 'w') as f:
        json.dump(videos, f, indent=2)

@app.route('/')
def index():
    videos = load_videos()
    return render_template('index.html', videos=videos)

@app.route('/upload', methods=['POST'])
def upload_video():
    if 'video' not in request.files:
        return jsonify({'error': 'No file selected'}), 400
    
    file = request.files['video']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if file:
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        
        # Get video duration using ffprobe
        try:
            result = subprocess.run([
                'ffprobe', '-v', 'error', '-show_entries', 
                'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filepath
            ], capture_output=True, text=True)
            duration = float(result.stdout.strip())
        except:
            duration = 0
        
        # Save video metadata
        videos = load_videos()
        video_id = str(len(videos) + 1)
        videos[video_id] = {
            'filename': filename,
            'filepath': filepath,
            'duration': duration,
            'original_segments': {},
            'resolutions': {},
            'resolution_segments': {}
        }
        save_videos(videos)
        
        return jsonify({
            'success': True,
            'video_id': video_id,
            'filename': filename,
            'duration': duration
        })
    
    return jsonify({'error': 'Upload failed'}), 500

@app.route('/video/<video_id>')
def get_video_file(video_id):
    videos = load_videos()
    if video_id in videos:
        video_path = videos[video_id]['filepath']
        if os.path.exists(video_path):
            return send_file(video_path)
    return jsonify({'error': 'Video not found'}), 404

@app.route('/segment/<video_id>/<resolution>/<segment_id>')
def get_segment_file(video_id, resolution, segment_id):
    videos = load_videos()
    print(f"Looking for segment: video_id={video_id}, resolution={resolution}, segment_id={segment_id}")  # Debug
    
    if video_id not in videos:
        return jsonify({'error': 'Video not found'}), 404
    
    video = videos[video_id]
    
    # Check for original segments
    if resolution == 'original' and 'original_segments' in video and segment_id in video['original_segments']:
        segment_path = video['original_segments'][segment_id]['path']
        if os.path.exists(segment_path):
            return send_file(segment_path)
    
    # Check for resolution segments
    if ('resolution_segments' in video and 
        resolution in video['resolution_segments'] and 
        segment_id in video['resolution_segments'][resolution]):
        
        segment_path = video['resolution_segments'][resolution][segment_id]['path']
        if os.path.exists(segment_path):
            return send_file(segment_path)
    
    print(f"Segment not found. Available: {list(video.keys())}")  # Debug
    return jsonify({'error': 'Segment not found'}), 404

@app.route('/videos')
def get_videos():
    videos = load_videos()
    return jsonify(videos)

@app.route('/segment')
def segment_page():
    videos = load_videos()
    return render_template('segment.html', videos=videos)

@app.route('/segment', methods=['POST'])
def segment_video():
    data = request.json
    video_id = data.get('video_id')
    num_segments = int(data.get('num_segments', 1))
    
    videos = load_videos()
    if video_id not in videos:
        return jsonify({'error': 'Video not found'}), 404
    
    video = videos[video_id]
    input_path = video['filepath']
    
    # Verify input file exists
    if not os.path.exists(input_path):
        return jsonify({'error': 'Input video file not found'}), 404
    
    duration = video['duration']
    segment_duration = duration / num_segments
    
    # Create segment directory for this video
    segment_dir = os.path.join(app.config['SEGMENT_FOLDER'], video_id, 'original')
    os.makedirs(segment_dir, exist_ok=True)
    
    # Segment original video using ffmpeg with proper encoding
    segments = {}
    for i in range(num_segments):
        start_time = i * segment_duration
        output_path = os.path.join(segment_dir, f'segment_{i+1}.mp4')
        
        try:
            # Use proper encoding instead of copy to ensure playable segments
            result = subprocess.run([
                'ffmpeg', '-i', input_path, 
                '-ss', str(start_time), 
                '-t', str(segment_duration),
                '-c:v', 'libx264',        # Re-encode video
                '-c:a', 'aac',           # Re-encode audio
                '-preset', 'fast',       # Faster encoding
                '-crf', '23',            # Good quality
                '-movflags', '+faststart', # Enable fast start
                '-y',                    # Overwrite output
                output_path
            ], capture_output=True, text=True, timeout=300)  # 5min timeout
            
            if result.returncode == 0:
                # Verify segment was created and is playable
                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    segments[str(i+1)] = {
                        'path': output_path,
                        'start_time': start_time,
                        'duration': segment_duration
                    }
                    print(f"✓ Successfully created segment {i+1}")
                else:
                    print(f"✗ Segment {i+1} file not created properly")
            else:
                print(f"✗ FFmpeg error for segment {i+1}: {result.stderr}")
                
        except subprocess.TimeoutExpired:
            print(f"✗ Segment {i+1} creation timed out")
        except Exception as e:
            print(f"✗ Error creating segment {i+1}: {str(e)}")
    
    # Update video metadata
    video['original_segments'] = segments
    video['segment_count'] = num_segments
    save_videos(videos)
    
    return jsonify({
        'success': True, 
        'segments': segments,
        'created_count': len(segments)
    })
@app.route('/resolution')
def resolution_page():
    videos = load_videos()
    return render_template('resolution.html', videos=videos)

@app.route('/resolution', methods=['POST'])
def create_resolutions():
    data = request.json
    video_id = data.get('video_id')
    
    videos = load_videos()
    if video_id not in videos:
        return jsonify({'error': 'Video not found'}), 404
    
    video = videos[video_id]
    input_path = video['filepath']
    
    # Get original video resolution using ffprobe
    try:
        result = subprocess.run([
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height', '-of', 'csv=p=0', input_path
        ], capture_output=True, text=True)
        original_resolution = result.stdout.strip()
        original_width, original_height = map(int, original_resolution.split(','))
        print(f"Original video resolution: {original_width}x{original_height}")
    except Exception as e:
        print(f"Error getting original resolution: {e}")
        return jsonify({'error': 'Could not determine original video resolution'}), 500
    
    # Define target resolutions (only lower than original)
    target_resolutions = {
        '4k': (3840, 2160),
        '1440p': (2560, 1440), 
        '1080p': (1920, 1080),
        '720p': (1280, 720),
        '480p': (854, 480),
        '360p': (640, 360),
        '240p': (426, 240),
        '144p': (256, 144)
    }
    
    # Filter resolutions to only include those smaller than original
    available_resolutions = {}
    for res_name, (width, height) in target_resolutions.items():
        if width <= original_width and height <= original_height:
            available_resolutions[res_name] = f"{width}:{height}"
    
    print(f"Available resolutions to generate: {list(available_resolutions.keys())}")
    
    # Create resolution directory
    resolution_dir = os.path.join(app.config['PLAYLIST_FOLDER'], video_id, 'resolutions')
    os.makedirs(resolution_dir, exist_ok=True)
    
    # Generate different resolutions (only downscaling)
    generated_resolutions = {}
    for res_name, res_value in available_resolutions.items():
        output_path = os.path.join(resolution_dir, f'{res_name}.mp4')
        
        try:
            # Use proper encoding for web compatibility
            result = subprocess.run([
                'ffmpeg', '-i', input_path, 
                '-vf', f'scale={res_value}:flags=lanczos',  # High-quality downscaling
                '-c:v', 'libx264',        # H.264 codec
                '-c:a', 'aac',           # AAC audio
                '-preset', 'medium',     # Balance between speed and quality
                '-crf', '23',            # Good quality setting
                '-movflags', '+faststart', # Web optimization
                '-y',                    # Overwrite output
                output_path
            ], capture_output=True, text=True, timeout=600)  # 10min timeout
            
            if result.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                generated_resolutions[res_name] = {
                    'path': output_path,
                    'resolution': res_value,
                    'original_resolution': f"{original_width}x{original_height}"
                }
                print(f"✓ Successfully created {res_name} resolution")
            else:
                print(f"✗ Failed to create {res_name} resolution")
                if result.stderr:
                    print(f"FFmpeg error: {result.stderr}")
                    
        except subprocess.TimeoutExpired:
            print(f"✗ Timeout creating {res_name} resolution")
        except Exception as e:
            print(f"✗ Error creating {res_name} resolution: {str(e)}")
    
    # Update video metadata
    video['resolutions'] = generated_resolutions
    video['original_resolution'] = f"{original_width}x{original_height}"
    save_videos(videos)
    
    return jsonify({
        'success': True, 
        'resolutions': generated_resolutions,
        'original_resolution': f"{original_width}x{original_height}",
        'generated_count': len(generated_resolutions)
    })
@app.route('/segment_resolutions', methods=['POST'])
def segment_resolutions():
    data = request.json
    video_id = data.get('video_id')
    
    videos = load_videos()
    if video_id not in videos:
        return jsonify({'error': 'Video not found'}), 404
    
    video = videos[video_id]
    
    if not video.get('resolutions'):
        return jsonify({'error': 'No resolutions found. Please create resolutions first.'}), 400
    
    if not video.get('segment_count'):
        return jsonify({'error': 'No segments defined. Please segment the video first.'}), 400
    
    num_segments = video['segment_count']
    duration = video['duration']
    segment_duration = duration / num_segments
    
    # Segment all resolutions
    resolution_segments = {}
    
    for resolution_name, resolution_info in video['resolutions'].items():
        resolution_path = resolution_info['path']
        
        # Skip if resolution file doesn't exist
        if not os.path.exists(resolution_path):
            print(f"✗ Resolution file not found: {resolution_path}")
            continue
            
        # Create segment directory for this resolution
        segment_dir = os.path.join(app.config['SEGMENT_FOLDER'], video_id, resolution_name)
        os.makedirs(segment_dir, exist_ok=True)
        
        segments = {}
        for i in range(num_segments):
            start_time = i * segment_duration
            output_path = os.path.join(segment_dir, f'segment_{i+1}.mp4')
            
            try:
                result = subprocess.run([
                    'ffmpeg', '-i', resolution_path, 
                    '-ss', str(start_time), 
                    '-t', str(segment_duration),
                    '-c:v', 'libx264',
                    '-c:a', 'aac',
                    '-preset', 'fast',
                    '-crf', '23',
                    '-movflags', '+faststart',
                    '-y',
                    output_path
                ], capture_output=True, text=True, timeout=300)
                
                if result.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    segments[str(i+1)] = {
                        'path': output_path,
                        'start_time': start_time,
                        'duration': segment_duration,
                        'resolution': resolution_name
                    }
                    print(f"✓ Created {resolution_name} segment {i+1}")
                else:
                    print(f"✗ Failed to create {resolution_name} segment {i+1}")
                    
            except Exception as e:
                print(f"✗ Error creating {resolution_name} segment {i+1}: {str(e)}")
        
        resolution_segments[resolution_name] = segments
    
    # Also segment original video with proper encoding
    original_segments = {}
    original_path = video['filepath']
    original_segment_dir = os.path.join(app.config['SEGMENT_FOLDER'], video_id, 'original')
    os.makedirs(original_segment_dir, exist_ok=True)
    
    for i in range(num_segments):
        start_time = i * segment_duration
        output_path = os.path.join(original_segment_dir, f'segment_{i+1}.mp4')
        
        try:
            result = subprocess.run([
                'ffmpeg', '-i', original_path, 
                '-ss', str(start_time), 
                '-t', str(segment_duration),
                '-c:v', 'libx264',
                '-c:a', 'aac',
                '-preset', 'fast',
                '-crf', '23',
                '-movflags', '+faststart',
                '-y',
                output_path
            ], capture_output=True, text=True, timeout=300)
            
            if result.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                original_segments[str(i+1)] = {
                    'path': output_path,
                    'start_time': start_time,
                    'duration': segment_duration,
                    'resolution': 'original'
                }
                print(f"✓ Created original segment {i+1}")
            else:
                print(f"✗ Failed to create original segment {i+1}")
                
        except Exception as e:
            print(f"✗ Error creating original segment {i+1}: {str(e)}")
    
    resolution_segments['original'] = original_segments
    
    # Update video metadata
    video['resolution_segments'] = resolution_segments
    save_videos(videos)
    
    return jsonify({
        'success': True, 
        'resolution_segments': resolution_segments,
        'created_count': {res: len(segs) for res, segs in resolution_segments.items()}
    })
@app.route('/player')
def player_page():
    videos = load_videos()
    return render_template('player.html', videos=videos)

@app.route('/playlist/<video_id>/<resolution>/<segment>')
def get_playlist_segment(video_id, resolution, segment):
    videos = load_videos()
    if (video_id in videos and 
        'resolution_segments' in videos[video_id] and
        resolution in videos[video_id]['resolution_segments'] and
        segment in videos[video_id]['resolution_segments'][resolution]):
        
        segment_path = videos[video_id]['resolution_segments'][resolution][segment]['path']
        if os.path.exists(segment_path):
            return send_file(segment_path)
    
    return jsonify({'error': 'Segment not found'}), 404

if __name__ == '__main__':
    app.run(debug=True)