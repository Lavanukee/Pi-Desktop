"""Mesh preparation shared by the stage workers that hand a mesh to a native
tool (AutoRemesher today, the rig worker next).

WHY THIS EXISTS — the retopo hole bug
-------------------------------------
A GLB stores *render* vertices: positions are duplicated at every UV seam and
normal split. TRELLIS-2 output is extreme about it — a measured example had
9,296 vertices for 2,200 distinct positions and 4,360 triangles. Exporting that
straight to OBJ hands AutoRemesher a mesh whose triangles share almost no
indices, so it reads as ~9k boundary edges: a cloud of disconnected islands
rather than a surface. AutoRemesher then remeshes the islands independently and
the result is riddled with gaping holes (verified: 1,891 non-quad faces, 1,324
non-manifold edges, visibly holed head/torso/limbs).

Welding by POSITION restores the real surface (measured on the same asset:
1,872 boundary edges -> 112, and after hole-filling -> 0, watertight). Every
native tool wants that mesh, not the render mesh.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import trimesh


@dataclass
class PrepReport:
    """What preparation actually did — surfaced to the user, never invented."""

    in_vertices: int = 0
    in_faces: int = 0
    out_vertices: int = 0
    out_faces: int = 0
    welded_vertices: int = 0
    removed_faces: int = 0
    dropped_components: int = 0
    boundary_before: int = 0
    boundary_after: int = 0
    filled_holes: int = 0
    watertight: bool = False
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "inVertices": self.in_vertices,
            "inFaces": self.in_faces,
            "outVertices": self.out_vertices,
            "outFaces": self.out_faces,
            "weldedVertices": self.welded_vertices,
            "removedFaces": self.removed_faces,
            "droppedComponents": self.dropped_components,
            "boundaryBefore": self.boundary_before,
            "boundaryAfter": self.boundary_after,
            "filledHoles": self.filled_holes,
            "watertight": self.watertight,
            "notes": self.notes,
        }


def count_boundary_edges(mesh: trimesh.Trimesh) -> int:
    """Edges used by exactly one face = the rim of a hole."""
    if len(mesh.faces) == 0:
        return 0
    edges = np.sort(mesh.edges_sorted, axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return int((counts == 1).sum())


def count_nonmanifold_edges(mesh: trimesh.Trimesh) -> int:
    """Edges shared by three or more faces."""
    if len(mesh.faces) == 0:
        return 0
    edges = np.sort(mesh.edges_sorted, axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return int((counts > 2).sum())


def load_concatenated(path: str) -> trimesh.Trimesh:
    """Load any supported file as ONE triangle mesh (scenes are concatenated)."""
    loaded = trimesh.load(path, force="mesh", process=False)
    if isinstance(loaded, trimesh.Scene):  # force='mesh' normally handles this
        loaded = loaded.dump(concatenate=True)
    if not isinstance(loaded, trimesh.Trimesh):
        raise RuntimeError(f"{path} did not load as a mesh")
    return loaded


def heal_for_native_tool(
    mesh: trimesh.Trimesh,
    log: Callable[[str], None] | None = None,
    *,
    fill: bool = True,
    min_component_faces: int = 24,
) -> tuple[trimesh.Trimesh, PrepReport]:
    """Turn a render mesh into a surface a native remesher can work with.

    Order matters: weld first (everything downstream depends on real adjacency),
    then drop junk faces, then drop specks, then fill, then unify winding.
    """
    say = log or (lambda _m: None)
    rep = PrepReport(in_vertices=len(mesh.vertices), in_faces=len(mesh.faces))

    # Geometry only — UV/normal/material channels are exactly what caused the
    # duplicate vertices, and no native remesher consumes them.
    work = trimesh.Trimesh(
        vertices=np.asarray(mesh.vertices, dtype=np.float64),
        faces=np.asarray(mesh.faces, dtype=np.int64),
        process=False,
    )
    rep.boundary_before = count_boundary_edges(work)

    before = len(work.vertices)
    work.merge_vertices(merge_tex=True, merge_norm=True)
    work.remove_unreferenced_vertices()
    rep.welded_vertices = before - len(work.vertices)
    if rep.welded_vertices > 0:
        say(f"Welded {rep.welded_vertices:,} duplicate vertices ({before:,} → {len(work.vertices):,})")

    faces_before = len(work.faces)
    work.update_faces(work.nondegenerate_faces())
    work.update_faces(work.unique_faces())
    work.remove_unreferenced_vertices()
    rep.removed_faces = faces_before - len(work.faces)
    if rep.removed_faces > 0:
        say(f"Removed {rep.removed_faces:,} degenerate/duplicate faces")

    # Loose specks (a few faces floating off the surface) become garbage quads
    # and can wreck the remesher's field. Keep every component with real area.
    if min_component_faces > 0:
        try:
            parts = work.split(only_watertight=False)
        except Exception as err:  # graph engine missing → skip, don't fail
            parts = []
            rep.notes.append(f"component split unavailable: {err}")
        if len(parts) > 1:
            keep = [p for p in parts if len(p.faces) >= min_component_faces]
            if len(keep) == 0:
                keep = [max(parts, key=lambda p: len(p.faces))]
            if len(keep) < len(parts):
                rep.dropped_components = len(parts) - len(keep)
                work = trimesh.util.concatenate(keep)
                work.merge_vertices(merge_tex=True, merge_norm=True)
                say(f"Dropped {rep.dropped_components} loose fragment(s)")

    if fill:
        holes = count_boundary_edges(work)
        if holes > 0:
            try:
                work.fill_holes()
                work.remove_unreferenced_vertices()
                rep.filled_holes = holes - count_boundary_edges(work)
                if rep.filled_holes > 0:
                    say(f"Closed {rep.filled_holes:,} boundary edges")
            except Exception as err:  # noqa: BLE001
                rep.notes.append(f"hole fill unavailable: {err}")

    try:
        work.fix_normals()
    except Exception as err:  # noqa: BLE001
        rep.notes.append(f"winding fix unavailable: {err}")

    rep.boundary_after = count_boundary_edges(work)
    rep.out_vertices = len(work.vertices)
    rep.out_faces = len(work.faces)
    rep.watertight = bool(work.is_watertight)
    return work, rep


def decimate_to(
    mesh: trimesh.Trimesh, max_faces: int, log: Callable[[str], None] | None = None
) -> trimesh.Trimesh:
    """Quadric-decimate down to `max_faces` when the mesh is heavier than that.

    AutoRemesher's cost is superlinear in input triangles and it gains nothing
    from density far above the quad target. MEASURED on this machine, same
    asset: 189,131 triangles ran for over 13 minutes without finishing;
    decimated to 40,000 first it finished in 4.7 s and produced a BETTER result
    (6,512 quads / 84 non-quads). Decimation is a speed decision, not a quality
    compromise — retopology discards the input tessellation either way.
    """
    say = log or (lambda _m: None)
    if max_faces <= 0 or len(mesh.faces) <= max_faces:
        return mesh
    before = len(mesh.faces)
    try:
        reduced = mesh.simplify_quadric_decimation(face_count=max_faces)
    except Exception as err:  # noqa: BLE001 — better slow than broken
        say(f"decimation unavailable ({err}) — remeshing the full-density mesh")
        return mesh
    say(f"Decimated {before:,} → {len(reduced.faces):,} triangles for remeshing")
    return reduced


def export_geometry_obj(mesh: trimesh.Trimesh, path: str) -> None:
    """Write a positions+faces-only OBJ (no vt/vn/mtllib).

    AutoRemesher reads OBJ through tiny_obj_loader and indexes by the `v` index;
    a `mtllib` line pointing at a texture we do not want it to read is pure
    noise, and any vt channel invites re-splitting downstream.
    """
    plain = trimesh.Trimesh(
        vertices=np.asarray(mesh.vertices, dtype=np.float64),
        faces=np.asarray(mesh.faces, dtype=np.int64),
        process=False,
    )
    plain.export(path, include_texture=False, include_color=False, include_normals=False)
