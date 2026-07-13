# Cesta hrdinov SNP a potraviny

Jednoducha staticka webova mapa Slovenska, ktora:

- nacita lokalny snapshot trasy Cesty hrdinov SNP z OpenStreetMap relacie `7700604`
- nacita lokalny snapshot OSM potravin v okoli trasy
- odfiltruje ich podla zvolenej vzdialenosti od chodnika

## Spustenie

V priecinku projektu spusti lokalny HTTP server, napriklad:

```powershell
python -m http.server 8080
```

Potom otvor v prehliadaci:

```text
http://localhost:8080
```

## Poznamky

- Data v priecinku `data/` su generovane z OpenStreetMap dat.
- Script `fetch_data.py` najprv stiahne trasu SNP a potom pouzije lokalny extract `data/slovakia-latest.osm.pbf` zo zdroja Geofabrik.
- Ak chces snapshot obnovit, spusti:

```powershell
python .\fetch_data.py
```

- Prvy beh moze trvat dlhsie, pretoze stahuje cely slovensky OSM extract.
- Zobrazene su len potraviny, ktore su skutocne zmapovane v OSM.
- Filter vzdialenosti je orientacny a pocita sa geometricky od trasy.