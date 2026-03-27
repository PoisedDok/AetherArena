from pathlib import Path


def test_migration_numbers_unique_and_ordered():
    migrations_dir = Path(__file__).resolve().parents[2] / "data" / "database" / "migrations"
    sql_files = sorted(
        [
            p for p in migrations_dir.glob("*.sql")
            if not p.name.endswith(".template.sql")
        ],
        key=lambda p: p.name
    )

    numbers = []
    for path in sql_files:
        prefix = path.name.split("_", 1)[0]
        assert prefix.isdigit() and len(prefix) == 3, f"Invalid migration prefix: {path.name}"
        numbers.append(int(prefix))

    assert len(numbers) == len(set(numbers)), "Duplicate migration numbers detected"
    assert numbers == sorted(numbers), "Migrations are not ordered by prefix"
