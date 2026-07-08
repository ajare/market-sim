"""
Name pools for randomly naming Captains, distinct by the kind of Faction
they crew for (see cli.py's fleet-building and World's auto-created
PoliceFleet): Spanish for PirateBrigade, Dutch for Company/SoloTrader,
English for PoliceFleet.
"""
import random
from typing import List

SPANISH_FIRST_NAMES: List[str] = [
    "Carlos", "Miguel", "Jose", "Javier", "Diego", "Rafael", "Alejandro",
    "Fernando", "Manuel", "Francisco", "Isabel", "Sofia", "Carmen", "Elena",
    "Lucia", "Marta", "Rosa", "Teresa", "Ana", "Beatriz",
]
SPANISH_LAST_NAMES: List[str] = [
    "Garcia", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
    "Perez", "Sanchez", "Ramirez", "Torres", "Flores", "Rivera", "Gomez",
    "Diaz", "Cruz", "Morales", "Ortiz", "Gutierrez", "Chavez", "Ramos",
]

DUTCH_FIRST_NAMES: List[str] = [
    "Jan", "Willem", "Pieter", "Hendrik", "Cornelis", "Dirk", "Klaas",
    "Gerrit", "Bram", "Sander", "Anna", "Maria", "Johanna", "Wilhelmina",
    "Cornelia", "Femke", "Sanne", "Lotte", "Anke", "Marieke",
]
DUTCH_LAST_NAMES: List[str] = [
    "de Vries", "Jansen", "de Jong", "Bakker", "Visser", "Smit", "Meijer",
    "de Boer", "Mulder", "de Groot", "Bos", "Vos", "Peters", "Hendriks",
    "van Dijk", "Dekker", "Brouwer", "van der Berg", "Willems", "Kok",
]

ENGLISH_FIRST_NAMES: List[str] = [
    "James", "William", "John", "Robert", "Michael", "Charles", "Thomas",
    "George", "Edward", "Henry", "Mary", "Elizabeth", "Margaret", "Catherine",
    "Alice", "Grace", "Emily", "Charlotte", "Victoria", "Eleanor",
]
ENGLISH_LAST_NAMES: List[str] = [
    "Smith", "Johnson", "Williams", "Brown", "Taylor", "Wilson", "Davies",
    "Evans", "Thomas", "Roberts", "Walker", "Wright", "Green", "Hall",
    "Wood", "Clarke", "Baker", "Turner", "Hughes", "Edwards",
]


def random_name(rng: random.Random, first_names: List[str], last_names: List[str]) -> str:
    """A random "First Last" name drawn from the given pools using `rng`."""
    return f"{rng.choice(first_names)} {rng.choice(last_names)}"
