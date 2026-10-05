#!/usr/bin/env python3
"""Allinea una volta la barra sinistra di Bottega, mentre l'app è chiusa."""
import json
import sqlite3
import sys


def aggiorna(db_path: str) -> None:
    con = sqlite3.connect(db_path)
    try:
        con.execute('BEGIN IMMEDIATE')
        marker = 'bottega.activitybar.personalizzata.v1'
        if con.execute('SELECT 1 FROM ItemTable WHERE key=?', (marker,)).fetchone():
            con.rollback()
            return
        key = 'workbench.activity.pinnedViewlets2'
        row = con.execute('SELECT value FROM ItemTable WHERE key=?', (key,)).fetchone()
        entries = json.loads(row[0]) if row else []
        if not isinstance(entries, list):
            entries = []
        wanted = [
            'workbench.view.explorer',
            'workbench.view.search',
            'workbench.view.extension.bottegaRegia',
            'workbench.view.extension.bottegaCruscotto',
            'workbench.view.extension.bottegaPlancia',
        ]
        old = {entry['id']: entry for entry in entries if isinstance(entry, dict) and isinstance(entry.get('id'), str)}
        updated = [{**old.get(id_, {}), 'id': id_, 'pinned': True, 'visible': True, 'order': n}
                   for n, id_ in enumerate(wanted)]
        updated.extend({**entry, 'pinned': False, 'visible': False}
                       for entry in entries if isinstance(entry, dict) and entry.get('id') not in wanted)
        con.execute('INSERT OR REPLACE INTO ItemTable(key,value) VALUES (?,?)', (key, json.dumps(updated, ensure_ascii=False)))
        con.execute('INSERT OR REPLACE INTO ItemTable(key,value) VALUES (?,?)', ('workbench.activity.showAccounts', 'false'))
        con.execute('INSERT OR REPLACE INTO ItemTable(key,value) VALUES (?,?)', (marker, 'true'))
        con.commit()
    finally:
        con.close()


if __name__ == '__main__':
    aggiorna(sys.argv[1])
