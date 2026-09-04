# Derelict Scotland

Интерактивная карта заброшенных, сгоревших и повреждённых штормом зданий Шотландии.

## Запуск

Файл `index.html` подгружает `data/sites.json` через `fetch`, поэтому открывать двойным кликом
нельзя (браузер заблокирует по CORS). Нужен локальный сервер:

```bash
python -m http.server 8000
```

Потом открыть http://localhost:8000

## Структура

```
index.html        разметка
assets/style.css  тёмная тема, инвертированные тайлы OSM
assets/app.js     Leaflet, фильтры, поиск, сортировка
data/sites.json   весь датасет — это единственный файл, который надо править
```

## Как добавить точку

Добавь объект в массив `sites` в `data/sites.json`:

```json
{
  "id": "kebab-case-unique-id",
  "name": "Название здания",
  "region": "Council area (напр. Glasgow, Fife, Highland)",
  "lat": 55.8600,
  "lng": -4.2500,
  "category": "fire",
  "type": "civic",
  "status": "Короткий статус — напр. Roofless shell",
  "year": 2026,
  "confidence": "verified",
  "summary": "2–4 предложения: что это было, что случилось, что сейчас.",
  "source": "https://ссылка-на-новость",
  "sourceName": "BBC Scotland"
}
```

Категории (`category`) — они же цвета пинов и фильтры:

| ключ | значение | цвет |
|---|---|---|
| `fire` | повреждено/уничтожено пожаром | оранжевый |
| `storm` | повреждено штормом | синий |
| `derelict` | заброшено, пустует, в группе риска | бежевый |
| `demolished` | снесено, больше не существует | фиолетовый |
| `ruin` | давняя историческая руина | зелёный |
| `village` | посёлок/остров, который покинули жители | бирюзовый |

Тип объекта (`type`) — выпадающий фильтр, цвет не меняет:

`hospital` · `mansion` · `military` · `school` · `industrial` · `village` · `island` ·
`religious` · `civic` · `castle`

Названия категорий и типов лежат в `meta.categories` и `meta.types` в том же JSON —
если добавляешь новый тип, впиши его туда, иначе он не попадёт в фильтр.

`confidence`: `verified` — координаты точные; `approximate` — привязка к территории объекта,
в попапе показывается предупреждение.

## Где искать новые объекты

- [Buildings at Risk Register for Scotland](https://buildingsatrisk.org.uk/) — основной реестр
  зданий под угрозой (обновление приостановлено, но архив доступен)
- [Scottish Fire and Rescue Service — News](https://www.firescotland.gov.uk/news/) — оперативные
  сводки по пожарам
- [Historic Environment Scotland](https://www.historicenvironment.scot/)
- Локальные СМИ: BBC Scotland, STV News, The Courier, Press & Journal, Glasgow Times, Scotsman

Координаты проще всего снимать правым кликом в Google Maps или через
[Nominatim](https://nominatim.openstreetmap.org/).

## Хостинг

Сайт полностью статический — заливается на GitHub Pages, Netlify или Cloudflare Pages как есть,
без сборки.

## Оговорка

Большинство объектов — частная собственность и/или аварийные конструкции. Датасет фиксирует
их существование, а не приглашает внутрь.
