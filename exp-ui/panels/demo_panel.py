from imgui_bundle import imgui

from app import Panel


class DemoPanel(Panel):
    title = "Demo"

    def __init__(self):
        self.counter = 0
        self.text = ""

    def render(self) -> None:
        imgui.text("Hello from the exp-ui framework")
        if imgui.button("Click me"):
            self.counter += 1
        imgui.text(f"Clicked {self.counter} times")
        _, self.text = imgui.input_text("Input", self.text)
