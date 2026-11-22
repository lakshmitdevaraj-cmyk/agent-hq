# Part 0: live-shaped counts (read in the signed-in browser pane on 22 Nov, 574 non-test leads; nothing exported or stored)

| | Old rule (live, 8b) | New rule |
|---|---|---|
| Hidden as lead-gen | 103 | 72 |
| Visible, flagged "Possible lead-gen: check" (10+ reviews, not contacted) | 0 | 17 |
| Visible, flagged because contacted (sent email, unsent draft, social, reply) | 0 | 14 |
| Old lead-gen leads with no sign under the new list | n/a | 0 |
| Hidden by the other rules (wholesaler, not home service, chain) | 22 | 21 hidden, 1 flagged (contacted) |

Hidden 72 and visible 31 match the 22 Nov simulation. The visible split is 17 / 14 here against 20 / 11 there because this
build counts a lead that only has an unsent email draft as contacted (as the rule is written); Max HVAC Services and A1 Plus are in that group.
19 further leads that the old rule did not catch now hide, because the new sign list includes a free Google Sites page,
a name that is only trade words and a town, and a one-city page on a keyword website (all under 10 reviews, not contacted).

## Fix after review: initials, LLC, Inc, Co are not "trade words and a town" (re-run live on 22 Nov)
A name with initials (MPG, ABC) or a company ending (LLC, Inc, Co, Corp, Ltd) no longer counts as a trade-words-only name.
Exactly four rows change, nothing else moves: MPG Plumbing LLC (x2, 2 reviews), ABC Pasadena Air & Heating (1) and
League City HVAC & Duct Services Co. (0) go from hidden to visible. Hidden by the lead-gen rule: 91 -> 87 (excluded leads left out).

## The leads that newly hide now (14 rows, none contacted, all under 10 reviews)
| Name | Reviews | Sign |
|---|---|---|
| Rudan LLc (x2) | 5 | free Google Sites page |
| Tank & Tankless Water Heaters Cypress | 3 | free Google Sites page |
| Gas Water Heaters The Woodlands TX | 0 | free Google Sites page |
| Water Heaters Leaking The Woodlands TX | 0 | free Google Sites page |
| Cypress TX Water Heaters Service | 1 | free Google Sites page + name is only trade words and a town |
| The Woodlands TX Water Heaters Installation | 2 | free Google Sites page + name is only trade words and a town |
| Water Heaters The Woodlands TX | 2 | free Google Sites page + name is only trade words and a town |
| Trusty Plumbers - Plumbing Services Woodlands | 8 | one city page on a keyword website |
| Foster AC & Heating | 2 | one city page on a keyword website |
| Diamond Peak HVAC | 0 | website name unrelated to the business name (.site) |
| Frontier Core HVAC | 0 | website name unrelated to the business name (.site) |
| Conroe Heating & Air Conditioning | 9 | name is only trade words and a town |
| Conroe AC Repair | 7 | name is only trade words and a town |

Closest to the line: Conroe Heating & Air Conditioning (9), Trusty Plumbers (8), Conroe AC Repair (7).
