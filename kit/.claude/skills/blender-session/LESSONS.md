# Уроки — связь с Blender

## 3DModelist (27 сентября) — пустое пространство имён

- Сервер внутри Blender (аддон Blender Lab и `blender/modelist_server.py`)
  исполняет присланный код в чистом пространстве имён. `tools/bl` работает,
  потому что прелюдия `lib/artist.py` сама делает `import bpy`; сырой код
  (`tools/bl --raw`, свой мост) без `import bpy` падает с `NameError`.
  Проверку связи писать с `import bpy` в первой строке.
