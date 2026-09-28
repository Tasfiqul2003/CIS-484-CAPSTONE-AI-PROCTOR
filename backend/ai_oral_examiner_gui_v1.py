import tkinter as tk


class AIOralExaminerGUI:
    def __init__(self, root):
        self.root = root

        self.root.title("AI Oral Examiner - Avatar Prototype V1")
        self.root.geometry("700x650")
        self.root.resizable(False, False)

        self.current_state = "Idle"
        self.mouth_open = False
        self.animation_job = None

        # -----------------------------------
        # TITLE
        # -----------------------------------

        self.title_label = tk.Label(
            root,
            text="AI ORAL EXAMINER",
            font=("Arial", 24, "bold")
        )

        self.title_label.pack(pady=20)

        # -----------------------------------
        # AVATAR CANVAS
        # -----------------------------------

        self.canvas = tk.Canvas(
            root,
            width=400,
            height=350
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

        # Left eye
        self.canvas.create_oval(
            140,
            110,
            165,
            135,
            fill="black"
        )

        # Right eye
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

        # -----------------------------------
        # STATUS
        # -----------------------------------

        self.status_label = tk.Label(
            root,
            text="Status: Idle",
            font=("Arial", 18, "bold")
        )

        self.status_label.pack(pady=10)

        self.info_label = tk.Label(
            root,
            text="AI Oral Examiner GUI Prototype",
            font=("Arial", 12)
        )

        self.info_label.pack(pady=5)

        # -----------------------------------
        # TEST BUTTONS
        # -----------------------------------

        self.button_frame = tk.Frame(root)
        self.button_frame.pack(pady=20)

        self.idle_button = tk.Button(
            self.button_frame,
            text="Idle",
            width=10,
            command=lambda: self.set_state("Idle")
        )

        self.idle_button.grid(
            row=0,
            column=0,
            padx=5
        )

        self.listening_button = tk.Button(
            self.button_frame,
            text="Listening",
            width=10,
            command=lambda: self.set_state("Listening")
        )

        self.listening_button.grid(
            row=0,
            column=1,
            padx=5
        )

        self.thinking_button = tk.Button(
            self.button_frame,
            text="Thinking",
            width=10,
            command=lambda: self.set_state("Thinking")
        )

        self.thinking_button.grid(
            row=0,
            column=2,
            padx=5
        )

        self.speaking_button = tk.Button(
            self.button_frame,
            text="Speaking",
            width=10,
            command=lambda: self.set_state("Speaking")
        )

        self.speaking_button.grid(
            row=0,
            column=3,
            padx=5
        )

    # -----------------------------------
    # CHANGE AVATAR STATE
    # -----------------------------------

    def set_state(self, new_state):

        self.current_state = new_state

        self.status_label.config(
            text=f"Status: {new_state}"
        )

        if new_state == "Speaking":
            self.start_mouth_animation()

        else:
            self.stop_mouth_animation()

    # -----------------------------------
    # MOUTH ANIMATION
    # -----------------------------------

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


# -----------------------------------
# START GUI
# -----------------------------------

root = tk.Tk()

app = AIOralExaminerGUI(root)

root.mainloop()