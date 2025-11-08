from flask import Flask, render_template, request, send_from_directory, redirect, url_for
import os
import subprocess

app = Flask(__name__)
UPLOAD_FOLDER = 'uploads'
SEGMENT_FOLDER = 'segments'

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['SEGMENT_FOLDER'] = SEGMENT_FOLDER

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(SEGMENT_FOLDER, exist_ok=True)

@app.route('/')
def index():
    files = os.listdir(UPLOAD_FOLDER)
    videos = [f for f in files if f.endswith(('.mp4', '.mov', '.avi', '.mkv'))]
    return render_template('index.html', videos=videos)

@app.route('/upload', methods=['POST'])
def upload():
    if 'videos' not in request.files:
        return 'No file part', 400

    files = request.files.getlist('videos')
    for file in files:
        if file.filename != '':
            filepath = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
            file.save(filepath)
    return 'Uploaded successfully!'

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# ---------- SEGMENTATION FEATURE ----------
@app.route('/segment')
def segment_page():
    videos = os.listdir(UPLOAD_FOLDER)
    videos = [v for v in videos if v.endswith(('.mp4', '.mov', '.avi', '.mkv'))]
    return render_template('segment.html', videos=videos)

@app.route('/segment_video', methods=['POST'])
def segment_video():
    video_name = request.form.get('video')
    num_segments = int(request.form.get('num_segments', 1))

    input_path = os.path.join(app.config['UPLOAD_FOLDER'], video_name)
    output_dir = os.path.join(app.config['SEGMENT_FOLDER'], os.path.splitext(video_name)[0])
    os.makedirs(output_dir, exist_ok=True)

    # Get total video duration (seconds)
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=noprint_wrappers=1:nokey=1', input_path],
        capture_output=True, text=True
    )
    duration = float(result.stdout.strip())
    segment_time = duration / num_segments

    output_pattern = os.path.join(output_dir, "part_%03d.mp4")

    # FFmpeg command for segmentation
    cmd = [
        'ffmpeg', '-i', input_path, '-c', 'copy', '-map', '0',
        '-f', 'segment', '-segment_time', str(segment_time),
        output_pattern, '-y'
    ]
    subprocess.run(cmd)

    segments = sorted(os.listdir(output_dir))
    return render_template('segment.html', videos=os.listdir(UPLOAD_FOLDER),
                           selected_video=video_name, segments=segments, output_dir=output_dir)

@app.route('/segments/<path:filename>')
def serve_segment(filename):
    return send_from_directory(app.config['SEGMENT_FOLDER'], filename)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
