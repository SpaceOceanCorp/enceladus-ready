# PlanetProfile output for Enceladus

`EnceladusProfile_Seawater_10.0ppt_Tb272.4578K_PorousRock_phi0.32_Pc3.50e+02.txt` is the unmodified output of
[PlanetProfile](https://github.com/vancesteven/PlanetProfile) 3.1.2 (Vance et al., JPL/Caltech) run with its
default Enceladus settings (`PlanetProfile/Default/Enceladus/PPEnceladus.py`). The browser globe reads three
numbers from its header to build the "PlanetProfile (JPL) default" interior model:

| Header field | Value | Meaning |
|---|---|---|
| `zb_km` | 21.221 | ice shell thickness (depth of the ice-ocean boundary) |
| `D_km` | 35.405 | ocean thickness |
| `RsilMean_m` | 195473.979 | radius of the porous rock core (no iron core) |

Other values shown in the globe's notes come from the same header: ocean density (`rhoOcean_kgm3`),
rock density (`rhoSil_kgm3`), rock porosity (`phiRockCalc_frac`), surface heat flow (`qSurf_Wm2`) and the
model's moment of inertia (`CMR2mean`, measured value 0.335).

PlanetProfile is GPL-3 software. It is not part of this project and the build never runs it; only this output
file is used. To reproduce it (any machine with Docker):

```sh
docker run -it --rm -v "$PWD:/work" -w /work condaforge/miniforge3 bash
mamba create -y -n pp python=3.11 reaktoro && conda activate pp
pip install PlanetProfile==3.1.2 pandas sqlalchemy "matplotlib<3.9"
python -m PlanetProfile.install          # answer y to its prompts
python -m PlanetProfile.Main Enceladus   # answer y; writes Enceladus/EnceladusProfile_*.txt
```

Setting `Params.SKIP_PLOTS = True` in `UserConfigs/configPP.py` skips the figures.

Cite: Vance, S. D. et al. (2018), Geophysical investigations of habitability in ice-covered ocean worlds,
J. Geophys. Res. Planets 123, 180–205, doi:10.1002/2017JE005341; and Styczinski, M. J. et al. (2023),
PlanetProfile, https://github.com/vancesteven/PlanetProfile.
