## PV 3D Bar-Graph

Toont de live opbrengst van individuele zonnepanelen als 3D-visualisatie op een
GLB-model van je gebouw. Panelen worden automatisch herkend en vullen zich van
onderaf: zwart (0 W) → blauw → groen (vol vermogen).

Na installatie: herstart Home Assistant en voeg de integratie toe via
**Instellingen → Apparaten & services**. Koppel je panelen aan sensoren via
`config/pv_3d_bargraph.yaml` of direct in de `custom:pv-3d-bargraph-card` kaart.
