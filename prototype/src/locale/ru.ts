// РУССКАЯ локаль. Канонический язык интерфейса — русский (msgid = русская строка),
// поэтому UI-строк здесь НЕТ: отсутствие записи = показать msgid как есть.
// Здесь живут только переводы ИМЁН ИГРОВЫХ ДАННЫХ (game.ts описывает юниты/здания/
// технологии/секторы/типы планет по-английски): ключ — `data:<английское имя>`,
// значение — русское имя. Один язык = один файл.
export const ru: Record<string, string> = {
  // --- units (displayUnit: id.replace('_',' ')) --------------------------------
  'data:scout': 'разведчик',
  'data:cruiser': 'крейсер',
  'data:siege': 'осадная платформа',
  'data:dropship': 'носитель',
  'data:fighter squadron': 'истребительная эскадрилья',
  'data:strike carrier': 'ударный носитель',
  'data:militia': 'ополчение',
  'data:heavy infantry': 'тяжёлая пехота',
  'data:special forces': 'спецназ',
  'data:tank': 'танк',
  'data:bomber': 'бомбардировщик',
  'data:aa': 'ПВО',
  'data:hero': 'флагман',

  // --- buildings (data.buildings[*].name) --------------------------------------
  'data:Metal Mine': 'Металлодобыча',
  'data:Credit Refinery': 'Кредитный НПЗ',
  'data:Hydroponics Farm': 'Гидропонная ферма',
  'data:Fusion Plant': 'Термоядерная станция',
  'data:Microelectronics Fab': 'Фабрика микроэлектроники',
  'data:Tax Office': 'Налоговая управа',
  'data:Salvage Metal Rig': 'Утилизационная станция',
  'data:Barracks': 'Казармы',
  'data:Radar Array': 'Радарный массив',
  'data:Void Fortress': 'Крепость пустоты',
  'data:Orbital AA': 'Орбитальное ПВО',
  'data:Fort': 'Форт',

  // --- terrain core (data.sectors[*].name) — speed/HP modifiers ----------------
  'data:Open space': 'Открытый космос',
  'data:Asteroid field': 'Астероидное поле',
  'data:Nebula': 'Туманность',
  'data:Ion Storm': 'Ионный шторм',
  'data:Dense Nebula': 'Плотная туманность',
  'data:Solar Flare Zone': 'Зона солнечных вспышек',
  'data:Derelict Graveyard': 'Кладбище кораблей',
  'data:Deep Void': 'Глубокая пустота',

  // --- province kind (SECTOR_TYPES[*].name) — structural sector type -----------
  'data:Planet': 'Планета',
  'data:Asteroid Field': 'Астероидное поле',
  'data:Empty Space': 'Пустое пространство',
  'data:Debris Field': 'Поле обломков',
  'data:Dead World': 'Мёртвый мир',

  // --- planet types (data.planetTypes[*].name) ---------------------------------
  'data:Terran': 'Земной',
  'data:Barren': 'Безжизненный',
  'data:Oceanic': 'Океанический',
  'data:Volcanic': 'Вулканический',
  'data:Gas Giant': 'Газовый гигант',
  'data:Crystalline': 'Кристаллический',
  'data:Fortress World': 'Мир-крепость',
  'data:Relic World': 'Реликтовый мир',
  'data:Irradiated': 'Облучённый',
  'data:Ringworld': 'Кольцевой мир',

  // --- technologies (data.technologies[*].name) --------------------------------
  'data:Industrial Automation': 'Промышленная автоматизация',
  'data:Orbital Logistics': 'Орбитальная логистика',
  'data:Siege Doctrine': 'Осадная доктрина',
  'data:Fortified Infrastructure': 'Укреплённая инфраструктура',
  'data:Microelectronics Fabrication': 'Производство микроэлектроники',

  // --- unit class tags (codexHtml "Класс": domain / line / traits) -------------
  'data:space': 'космос',
  'data:ground': 'земля',
  'data:front': 'передняя линия',
  'data:rear': 'тыл',
  'data:artillery': 'артиллерия',
  'data:carrier': 'носитель',
  'data:squadron': 'эскадрилья',

  // --- top-bar resource chip titles (capitalized English literals) ------------
  'data:Credits': 'Кредиты',
  'data:Food': 'Пища',
  'data:Metal': 'Металл',
  'data:Energy': 'Энергия',
  'data:Microelectronics': 'Микроэлектроника',

  // --- resource ids (lowercase — building "Produces"/"Upkeep" rows, market) ----
  'data:credits': 'кредиты',
  'data:food': 'пища',
  'data:metal': 'металл',
  'data:energy': 'энергия',
  'data:microelectronics': 'микроэлектроника',
};
