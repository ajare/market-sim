from imgui_bundle import imgui

from app import Panel
from sim.state import SimState

# Event.type (see sim/events.py's Event base class) -> the label this panel
# shows/filters by.
_EVENT_TYPE_LABELS = {
    "Global": "Global",
    "Location": "Location",
    "Worldwide": "Worldwide",
    "Local": "Local",
    "Agent": "Transport",
    "Company": "Company",
    "Closure": "Port Closure",
}

FILTERABLE_EVENT_TYPES = [
    "Global", "Location", "Worldwide", "Local",
    "Transport", "Company", "Port Closure",
]


class EventsPanel(Panel):
    title = "Event Log"

    def __init__(self, state: SimState):
        self.state = state
        self.selected_types: set[str] = set(FILTERABLE_EVENT_TYPES)
        self.subject_filter: str = ""

    def _render_type_filter(self) -> None:
        all_selected = len(self.selected_types) == len(FILTERABLE_EVENT_TYPES)
        label = "Event Types (All)" if all_selected else f"Event Types ({len(self.selected_types)})"
        if imgui.button(label):
            imgui.open_popup("event_type_filter_popup")

        if imgui.begin_popup("event_type_filter_popup"):
            if imgui.small_button("All"):
                self.selected_types = set(FILTERABLE_EVENT_TYPES)
            imgui.same_line()
            if imgui.small_button("None"):
                self.selected_types = set()
            imgui.separator()
            for event_type in FILTERABLE_EVENT_TYPES:
                checked = event_type in self.selected_types
                changed, checked = imgui.checkbox(event_type, checked)
                if changed:
                    if checked:
                        self.selected_types.add(event_type)
                    else:
                        self.selected_types.discard(event_type)
            imgui.end_popup()

    def _rows(self):
        """Every row this panel can show, sorted by day: every Event
        SimState has recorded, already fully structured -- see
        sim/events.py's Event and SimState.events. Trade activity
        (BUY/SELL/REFUEL/ATTACK/REPOSITION, see Captain.trade_log)
        deliberately isn't shown here."""
        rows = [
            (event.day or 0, _EVENT_TYPE_LABELS.get(event.type, event.type),
             event.scope, event.subject, event.message)
            for event in self.state.events
        ]
        rows.sort(key=lambda row: row[0])
        return rows

    def render(self) -> None:
        self._render_type_filter()
        imgui.same_line()
        imgui.set_next_item_width(160.0)
        _, self.subject_filter = imgui.input_text("Subject filter", self.subject_filter)

        flags = (
            imgui.TableFlags_.borders | imgui.TableFlags_.row_bg
            | imgui.TableFlags_.resizable | imgui.TableFlags_.scroll_y
        )
        if not imgui.begin_table("event_log_table", 5, flags):
            return
        imgui.table_setup_column("Day", imgui.TableColumnFlags_.width_fixed, 50.0)
        imgui.table_setup_column("Event Type", imgui.TableColumnFlags_.width_fixed, 110.0)
        imgui.table_setup_column("Scope", imgui.TableColumnFlags_.width_fixed, 120.0)
        imgui.table_setup_column("Subject", imgui.TableColumnFlags_.width_fixed, 140.0)
        imgui.table_setup_column("Message")
        imgui.table_setup_scroll_freeze(0, 1)
        imgui.table_headers_row()

        for day, event_type, scope, subject, message in self._rows():
            if event_type not in self.selected_types:
                continue
            if self.subject_filter.strip() and self.subject_filter.lower() not in subject.lower():
                continue
            imgui.table_next_row()
            imgui.table_next_column()
            imgui.text(str(day))
            imgui.table_next_column()
            imgui.text(event_type)
            imgui.table_next_column()
            imgui.text(scope)
            imgui.table_next_column()
            imgui.text(subject)
            imgui.table_next_column()
            imgui.text_unformatted(message)

        if imgui.get_scroll_y() >= imgui.get_scroll_max_y():
            imgui.set_scroll_here_y(1.0)
        imgui.end_table()
