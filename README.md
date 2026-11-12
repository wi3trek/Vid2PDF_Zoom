# Vid2PDF Zoom

Vid2PDF Zoom is a local app for pulling a subject out of a video and exporting the cropped frames as a PDF. It is aimed at parachute video, where you want the canopy (or any other subject) framed the same way from one moment to the next.

You draw a box with a crosshair on the subject, set keyframes where the subject moves, and the app fills in the frames between those points. You can turn the box so the page stays upright, trim the clip, watch a preview of the crop, and then export one PDF page per frame. The PDF is built from the original frames, so the crop is not run through a second video encode.

The page stays on your computer. Nothing is uploaded.

This project sits next to [vid2pdf](https://github.com/sco1/vid2pdf). vid2pdf turns a whole video into a contact sheet of frames. Vid2PDF Zoom adds the crop, the keyframes, and the preview.

## What you need

- A Windows, Mac, or Linux computer
- Python 3.11 or newer
- A video file the app can open (mp4 is the usual choice)

You do not need to install ffmpeg yourself. The Python packages below include a copy.

## Install it on Windows

These steps assume you have never used Python. You only do the Python install once. After that, starting the app is one command.

### 1. Install Python

1. Open [python.org/downloads](https://www.python.org/downloads/) and download the latest Windows installer (the button says something like "Download Python 3.x.x").
2. Run the installer.
3. On the first screen, check **Add python.exe to PATH**. This box is easy to miss, and the app will not start without it.
4. Click **Install Now**.
5. When it finishes, close the installer.

Check that it worked. Open the Start menu, type `cmd`, and open **Command Prompt**. Type this and press Enter:

```bat
python --version
```

You should see something like `Python 3.13.1`. The number can be higher. It needs to be 3.11 or above.

If a window for the Microsoft Store opens instead, the installer did not get onto PATH. Close the Store, run the Python installer again, choose **Modify**, and turn on **Add python.exe to PATH**. Then close Command Prompt, open a new one, and try `python --version` again.

### 2. Download this project

1. Open the project page on GitHub: [github.com/wi3trek/Vid2PDF_Zoom](https://github.com/wi3trek/Vid2PDF_Zoom).
2. Click the green **Code** button.
3. Click **Download ZIP**.
4. Find the zip in your Downloads folder. Right-click it and choose **Extract All**.
5. Put the extracted folder somewhere you can find again, such as `C:\Users\YourName\Code\Vid2PDF_Zoom`. Leave the files inside that folder.

If you already use Git, this is the same thing:

```bat
git clone https://github.com/wi3trek/Vid2PDF_Zoom.git
cd Vid2PDF_Zoom
```

### 3. Start the app

1. Open the project folder.
2. Click the address bar at the top of that folder window, type `cmd`, and press Enter. A black Command Prompt window opens in the right folder.
3. Copy the three lines below. In the black window, right-click to paste, then press Enter.

```bat
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe server.py
```

The first line makes a private folder named `.venv` for this app. The second downloads the libraries (FastAPI, Pillow, fpdf2, and a few others). The third starts the app. The first time, the download can take a minute. Leave the window open.

Paste all three lines. Typing only `python server.py` skips the libraries and stops with `No module named 'fastapi'`.

When the download finishes, the browser opens to:

[http://127.0.0.1:8765](http://127.0.0.1:8765)

That address only works on your machine. The next time you want the app, open Command Prompt in the folder again and run only the last line:

```bat
.venv\Scripts\python.exe server.py
```

The black window is the app. Closing it stops the app. If the page will not load, check that the window is still open.

## Install it on macOS or Linux

Install Python 3.11 or newer from [python.org](https://www.python.org/downloads/) or your system package manager. Then, in a terminal:

```bash
git clone https://github.com/wi3trek/Vid2PDF_Zoom.git
cd Vid2PDF_Zoom
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py
```

The browser opens to [http://127.0.0.1:8765](http://127.0.0.1:8765). Press Ctrl+C in the terminal when you want to quit.

## Use the app

### Open a video

In the **Video** section, paste the full path to the file (for example `C:\Videos\jump.mp4`) and click **Open**. **Browse** opens a file dialog instead.

The picture appears with a box and a crosshair. The readout under the path shows the frame size, frame rate, and length.

### Choose the page shape

**Output frame** sets the shape of the box and of every PDF page. Pick a preset such as 16:9, 4:3, or 1:1, or type a custom width and height. 1× zoom is the largest box of that shape that fits in the frame.

### Place the box

- Drag inside the box to move the crosshair onto the subject.
- Use the **Zoom** slider, or type a number in **Zoom ×**, to change how tight the box is. Higher zoom means a smaller window. The **Crop** field shows the size in source pixels.
- Drag a corner to turn the page around the crosshair. The zoom stays where you set it. **TOP**, written along one edge, is the top of each PDF page. A mark points out from that edge, and the two corners on it are round. If the page is upside down, TOP reads upside down. **Level** puts that edge back up.
- Alt and the arrow keys nudge the box. Hold Shift to nudge by 10 pixels.

### Mark the motion

Move the playhead to a moment where the subject should be framed a certain way, place the box, and click **Set keyframe** (or press K). Do that again wherever the subject changes direction or speed.

Frames between keyframes are filled in. The box is gold on a keyframe and blue on an in-between frame. Keyframes outside the start and end still steer the path.

### Trim, then check the result

**Set start** and **Set end** (or `[` and `]`) choose the span that review and the PDF use.

Click **Render review**. The app builds a short video of just the crop and switches to the Review tab. Watch it. If the subject drifts, go back to Edit, add a keyframe, and render again. The crosshair can be drawn on this preview. It is never drawn on the PDF.

### Export the PDF

**Export PDF** writes one page per kept frame. Step 1 keeps every frame, which matches vid2pdf. A higher step skips frames and makes a shorter document. If the export would be more than 800 pages, the app asks you to confirm before it starts.

Finished files land in the `output\jobs` folder inside the project. Buttons at the bottom of the page open the folder or the file.

### Picture and timeline

These change what you look at. They do not change the crop.

- The scroll wheel over the picture magnifies toward the cursor. Middle-drag, right-drag, or Alt-drag pans. `+` and `−` zoom from the center. `0` or **Reset view** clears it.
- The scroll wheel over the timeline zooms the timeline around the cursor. Shift-scroll pans it. **Trim** frames the start-to-end range. `\` or **Fit** shows the whole clip.

### Keys

| Key | Action |
| --- | --- |
| Space | Play and pause |
| `,` and `.`, or Left and Right | Step one frame. Shift steps one second |
| Shift+`,` and Shift+`.` | Previous and next keyframe |
| Alt+arrows | Nudge the box. Shift nudges by 10 pixels |
| `[` and `]` | Set start and end |
| K | Set a keyframe |
| Delete | Remove the keyframe on this frame |
| Ctrl+Z, Ctrl+Y | Undo and redo |
| `+` and `−` | Magnify the picture |
| `0` | Reset the picture view |
| `\` | Fit the timeline to the whole clip |

### Saved work

The crop, keyframes, trim, and page shape are saved automatically. A copy is written beside the video as `your-video.mp4.zoom.json`, and another copy is kept in `output\projects`. Open the same video again and the marks come back.

## Stop the app

Close the black Command Prompt window, or press Ctrl+C in that window. The browser tab can stay open. It will show an error until you start the app again.

Starting the app a second time while the first window is still open fails, because port 8765 is already taken. Close the first window, then start it again.

## Optional desktop shortcut (Windows)

Chrome warns about a downloaded zip that already contains a `.bat` file, so the download does not include one. After the app has started once, you can make your own double-click launcher on the computer:

1. Open Notepad and paste this:

```bat
@echo off
cd /d "%~dp0"
.venv\Scripts\python.exe server.py
```

2. Choose **File → Save As**. Go to the project folder. Set **Save as type** to **All files**. Name the file `run.bat`.
3. Right-click `run.bat`, choose **Create shortcut**, and move the shortcut to the desktop.
4. Right-click the shortcut, choose **Properties**, and set **Start in** to the project folder.
5. The file `vid2pdf-zoom.ico` in the project folder can be used as the shortcut icon (**Change Icon**).

## If something goes wrong

**Chrome says "Virus detected" on the GitHub zip.** That warning came from an older copy of this project that included a `run.bat` launcher. The file is a normal installer script, and it is no longer in the download. Download the zip again. If Chrome still blocks it, open the download entry, choose **Keep** or **Download anyway**, or clone the project with Git instead of using the zip.

**SSL, certificate, or `CERTIFICATE_VERIFY_FAILED` while downloading.** The computer is online, but Python does not trust the certificate it was shown. Antivirus "HTTPS scanning" and school or office networks cause this, and so does a wrong date and time. Check the clock first. Then, in Command Prompt, in the project folder, run:

```bat
python -m venv .venv
.venv\Scripts\python.exe -m pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.python.org -r requirements.txt
.venv\Scripts\python.exe server.py
```

On macOS or Linux, use `.venv/bin/python` instead of `.venv\Scripts\python.exe`.

**`No module named 'fastapi'`** (the name is one word, fastapi). The libraries were never installed, usually because only `python server.py` was typed. Run all three commands from the Windows install steps above.

**`python` is not recognized.** Python is not on PATH. Repeat the installer step and check **Add python.exe to PATH**, then open a new Command Prompt.

**The Microsoft Store opens when you type python.** Same fix as above. The Store stub is not a Python install.

**The first launch stops while downloading.** If the window mentions SSL or a certificate, use the certificate steps above. Otherwise check the network connection and run the three install commands again. Pip resumes a download that was interrupted.

**The browser does not open.** Look at the black window for an error. You can also open [http://127.0.0.1:8765](http://127.0.0.1:8765) yourself.

**Address already in use.** The app is already running. Use the existing window, or close it and start again.

**The video opens but will not play in the browser.** Some codecs do not play in a browser. Use **Browse** or **Open** on an mp4, or make a playable preview from the button the app shows. Export still uses the original file.

**A status line says ffmpeg was not found.** The bundled copy should be installed with the other libraries. In the project folder, run:

```bat
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

If you already have ffmpeg and want the app to use that copy, set the `FFMPEG_PATH` environment variable to the `ffmpeg.exe` file or to the folder that contains it.

## Run the tests

From the project folder, after the install above:

```bat
.venv\Scripts\python.exe -m unittest tests.test_zoom_math tests.test_engine -q
```

On macOS or Linux, with the virtual environment activated:

```bash
python -m unittest tests.test_zoom_math tests.test_engine -q
```

## Project layout

| Path | What it is |
| --- | --- |
| `server.py` | The local web server |
| `engine.py` | Frame decoding, the crop, the review video, and the PDF |
| `zoom_math.py` | Box size, interpolation, and rotation math |
| `static/` | The page you use in the browser |
| `requirements.txt` | The Python libraries |
| `output/` | Reviews, PDFs, and saved projects. Created when you use the app. Not part of the download |
