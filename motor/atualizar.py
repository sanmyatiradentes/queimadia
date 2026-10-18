"""Ciclo de atualização: coleta → eventos → publicação.

    python -m motor.atualizar            # um ciclo completo
    python -m motor.atualizar --rapido   # só tempo real (10 min) + republicação
"""
import sys
import time
import traceback

from . import ingest, eventos, publicar, precalcular


def ciclo(rapido=False):
    t0 = time.time()
    if not rapido:
        ingest.areas()
        ingest.historico_ref()
        ingest.inicializar_ano_corrente()
        for etapa in (ingest.atualizar_deter, ingest.atualizar_diario):
            try:
                print(etapa.__name__, etapa())
            except Exception:
                traceback.print_exc()
    try:
        print("atualizar_10min", ingest.atualizar_10min())
    except Exception:
        traceback.print_exc()
    df, evs, alertas = eventos.calcular()
    est = publicar.publicar(df, evs, alertas)
    if "--sem-ndvi" not in sys.argv:
        try:
            precalcular.ciclo(evs)
        except Exception:
            traceback.print_exc()
    ingest.salvar_status(ultimo_ciclo=est["gerado_em"], duracao_ciclo_s=round(time.time() - t0, 1))
    print(f"ok: {len(evs)} eventos, {len(alertas)} alertas em tempo real, {time.time() - t0:.0f}s")
    return est


if __name__ == "__main__":
    ciclo(rapido="--rapido" in sys.argv)
