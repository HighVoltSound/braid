extends SceneTree
## Compiles every script and loads every scene and resource in the project, so parse errors,
## type errors and broken references surface even where nothing loads them yet.
## Skips addons and editor-only scripts: they need the editor to compile.
## Exit 0 clean, 1 something failed, 2 watchdog.


func _initialize() -> void:
	create_timer(300.0).timeout.connect(func() -> void:
		printerr("braid: godot_check timed out")
		quit(2))
	# Autoload names only resolve after the first frame.
	await process_frame
	var me: String = get_script().resource_path
	var files := PackedStringArray()
	_collect("res://", files)
	var bad := 0
	for path in files:
		if path == me:
			continue
		var res := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		var ok := res != null
		# @abstract scripts compile fine but cannot be instantiated.
		if ok and res is Script and not FileAccess.get_file_as_string(path).contains("@abstract"):
			ok = (res as Script).can_instantiate()
		if not ok:
			bad += 1
			printerr("braid: cannot load ", path)
	print("braid: loaded %d files, %d failed" % [files.size() - bad, bad])
	quit(1 if bad else 0)


func _collect(dir: String, out: PackedStringArray) -> void:
	# Godot itself ignores folders marked with .gdignore.
	if FileAccess.file_exists(dir.path_join(".gdignore")):
		return
	for f in DirAccess.get_files_at(dir):
		var path := dir.path_join(f)
		if f.get_extension() in ["gd", "tscn", "tres"] and not _editor_only(path):
			out.append(path)
	for d in DirAccess.get_directories_at(dir):
		if not d.begins_with(".") and not (d == "addons" and dir == "res://"):
			_collect(dir.path_join(d), out)


func _editor_only(path: String) -> bool:
	if not path.ends_with(".gd"):
		return false
	var text := FileAccess.get_file_as_string(path)
	return text.contains("extends Editor") or text.contains("EditorInterface")
