import tkinter as tk
import subprocess
import threading
import queue
import sys
from pathlib import Path


# ============================================================
# FILE LOCATIONS
# ============================================================

# Resolve the checkout from this file, independently of the launch directory.
PROJECT_FOLDER = Path(__file__).resolve().parents[1]

FOUNDATION_FOLDER = PROJECT_FOLDER / "backend"

FOUNDATION_SCRIPT = (
    FOUNDATION_FOLDER / "ai_oral_examiner_foundation_v1.py"
)


# ============================================================
# GUI
# ============================================================

class AIOralExaminerGUI:

    def __init__(self, root):

        self.root = root

        self.root.title(
            "AI Oral Examiner - Integrated GUI V1"
        )

        self.root.geometry("700x700")

        self.current_state = "Idle"

        self.mouth_open = False

        self.animation_job = None

        self.ai_running = False

        self.event_queue = queue.Queue()


        # ----------------------------------------------------
        # TITLE
        # ----------------------------------------------------

        title = tk.Label(
            root,
            text="AI ORAL EXAMINER",
            font=("Arial", 24, "bold")
        )

        title.pack(pady=20)


        # ----------------------------------------------------
        # AVATAR
        # ----------------------------------------------------

        self.canvas = tk.Canvas(
            root,
            width=400,
            height=340
        )

        self.canvas.pack()


        # Head

        self.canvas.create_oval(
            90,
            30,
            310,
            310,
            width=3
        )


        # Eyes

        self.canvas.create_oval(
            140,
            110,
            165,
            135,
            fill="black"
        )

        self.canvas.create_oval(
            235,
            110,
            260,
            135,
            fill="black"
        )


        # Nose

        self.canvas.create_line(
            200,
            140,
            190,
            190,
            205,
            190,
            width=2
        )


        # Mouth

        self.mouth = self.canvas.create_oval(
            165,
            230,
            235,
            238,
            fill="black"
        )


        # ----------------------------------------------------
        # STATUS
        # ----------------------------------------------------

        self.status_label = tk.Label(
            root,
            text="Status: Idle",
            font=("Arial", 18, "bold")
        )

        self.status_label.pack(pady=10)


        self.info_label = tk.Label(
            root,
            text="Ready to begin voice interaction.",
            font=("Arial", 11)
        )

        self.info_label.pack(pady=5)


        # ----------------------------------------------------
        # START BUTTON
        # ----------------------------------------------------

        self.start_button = tk.Button(
            root,
            text="Start Voice Interaction",
            font=("Arial", 12),
            width=24,
            height=2,
            command=self.start_ai
        )

        self.start_button.pack(pady=15)


        # ----------------------------------------------------
        # SESSION LOG
        # ----------------------------------------------------

        self.log_box = tk.Text(
            root,
            width=75,
            height=9,
            state="disabled"
        )

        self.log_box.pack(pady=10)


        # Check worker messages every 100 ms

        self.root.after(
            100,
            self.check_events
        )


    # ========================================================
    # CHANGE AVATAR STATE
    # ========================================================

    def set_state(self, new_state):

        self.current_state = new_state

        self.status_label.config(
            text=f"Status: {new_state}"
        )


        if new_state == "Speaking":

            self.start_mouth_animation()

        else:

            self.stop_mouth_animation()


    # ========================================================
    # MOUTH ANIMATION
    # ========================================================

    def start_mouth_animation(self):

        if self.animation_job is None:

            self.animate_mouth()


    def animate_mouth(self):

        if self.current_state != "Speaking":

            self.stop_mouth_animation()

            return


        if self.mouth_open:

            self.canvas.coords(
                self.mouth,
                165,
                230,
                235,
                238
            )

            self.mouth_open = False


        else:

            self.canvas.coords(
                self.mouth,
                175,
                210,
                225,
                255
            )

            self.mouth_open = True


        self.animation_job = self.root.after(
            180,
            self.animate_mouth
        )


    def stop_mouth_animation(self):

        if self.animation_job is not None:

            self.root.after_cancel(
                self.animation_job
            )

            self.animation_job = None


        self.mouth_open = False


        self.canvas.coords(
            self.mouth,
            165,
            230,
            235,
            238
        )


    # ========================================================
    # SESSION LOG
    # ========================================================

    def add_log(self, message):

        self.log_box.config(
            state="normal"
        )

        self.log_box.insert(
            tk.END,
            message + "\n"
        )

        self.log_box.see(
            tk.END
        )

        self.log_box.config(
            state="disabled"
        )


    # ========================================================
    # START FOUNDATION V1
    # ========================================================

    def start_ai(self):

        if self.ai_running:

            return


        self.ai_running = True


        self.start_button.config(
            state="disabled"
        )


        self.add_log(
            "Starting AI Oral Examiner Foundation V1..."
        )


        worker = threading.Thread(
            target=self.run_foundation,
            daemon=True
        )


        worker.start()


    # ========================================================
    # RUN FOUNDATION IN BACKGROUND
    # ========================================================

    def run_foundation(self):

        try:

            process = subprocess.Popen(

                [
                    sys.executable,
                    "-u",
                    str(FOUNDATION_SCRIPT)
                ],

                # Foundation resolves voice models and temporary WAVs from cwd.
                cwd=str(
                    PROJECT_FOLDER
                ),

                stdout=subprocess.PIPE,

                stderr=subprocess.STDOUT,

                text=True,

                bufsize=1
            )


            for line in process.stdout:

                line = line.strip()


                if not line:

                    continue


                self.event_queue.put(
                    (
                        "log",
                        line
                    )
                )


                # --------------------------------------------
                # CONNECT FOUNDATION OUTPUT TO AVATAR STATES
                # --------------------------------------------

                if "Loading speech recognition model" in line:

                    self.event_queue.put(
                        (
                            "state",
                            "Loading"
                        )
                    )


                elif "Get ready" in line:

                    self.event_queue.put(
                        (
                            "state",
                            "Get Ready"
                        )
                    )


                elif "Listening" in line:

                    self.event_queue.put(
                        (
                            "state",
                            "Listening"
                        )
                    )


                elif "Converting speech to text" in line:

                    self.event_queue.put(
                        (
                            "state",
                            "Thinking"
                        )
                    )


                elif "Sending transcription" in line:

                    self.event_queue.put(
                        (
                            "state",
                            "Thinking"
                        )
                    )


                elif "Generating AI voice response" in line:

                    self.event_queue.put(
                        (
                            "state",
                            "Thinking"
                        )
                    )


                elif "Playing AI response" in line:

                    self.event_queue.put(
                        (
                            "state",
                            "Speaking"
                        )
                    )


                elif "AI finished speaking" in line:

                    self.event_queue.put(
                        (
                            "state",
                            "Idle"
                        )
                    )


            process.wait()


            self.event_queue.put(
                (
                    "finished",
                    None
                )
            )


        except Exception as error:

            self.event_queue.put(
                (
                    "error",
                    str(error)
                )
            )


    # ========================================================
    # RECEIVE BACKGROUND EVENTS
    # ========================================================

    def check_events(self):

        try:

            while True:

                event_type, data = (
                    self.event_queue.get_nowait()
                )


                if event_type == "log":

                    self.add_log(
                        data
                    )


                elif event_type == "state":

                    self.set_state(
                        data
                    )


                elif event_type == "finished":

                    self.set_state(
                        "Idle"
                    )

                    self.ai_running = False

                    self.start_button.config(
                        state="normal"
                    )

                    self.add_log(
                        "Voice interaction complete."
                    )


                elif event_type == "error":

                    self.set_state(
                        "Idle"
                    )

                    self.ai_running = False

                    self.start_button.config(
                        state="normal"
                    )

                    self.add_log(
                        "ERROR: " + data
                    )


        except queue.Empty:

            pass


        self.root.after(
            100,
            self.check_events
        )


# ============================================================
# START GUI
# ============================================================

root = tk.Tk()

app = AIOralExaminerGUI(root)

root.mainloop()