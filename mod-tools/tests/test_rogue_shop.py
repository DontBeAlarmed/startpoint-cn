# -*- coding: utf-8 -*-
"""深渊连战兑换商店生成器测试（合成数据，不读取真实 CN store）。"""
from __future__ import annotations

import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wf_mod_tool as core  # noqa: E402
import wf_rogue_rewards as rewards  # noqa: E402
import wf_rogue_shop as shop  # noqa: E402


SHOP_IDS = tuple(str(9_700_101 + index) for index in range(15))
CLIENT_FIELDS = {
    0: "6",
    1: "700099",
    2: "11",
    9: "1",
    18: "2370099",
    26: "2000-01-01 00:00:00",
    27: "2099-12-31 23:59:59",
    28: "0",
    29: "5",
    30: "5",
    31: "(None)",
    32: "4",
    34: "1",
}
OVERWRITTEN_COLUMNS = set(CLIENT_FIELDS) | {7, 8, 10, 11, 13, 14, 19, 33}


def template_row(length: int = 51) -> list[str]:
    row = [f"template-{index}" for index in range(length)]
    for index in (3, 4, 6, 12, 15, 17, 20, 22, 24, 31, 35, 38, 41, 44, 47):
        if index < length:
            row[index] = "(None)"
    return row


def client_fixture(*, template_length: int = 51) -> dict[str, object]:
    return {
        "9000000": "unrelated-high",
        "700099": core.write_csv_lines([["stale-client-row"]]),
        "310200": core.write_csv_lines([template_row(template_length)]),
        "2": "unrelated-low",
    }


def server_fixture() -> tuple[dict, dict]:
    donor = {
        "costs": [{"id": 50103, "amount": 30}],
        "rewards": [{"type": 4, "id": 5050015, "count": 1}],
        "availableFrom": "2022-12-01 12:00:00",
        "availableUntil": "2022-12-23 11:59:59",
        "stock": 2,
    }
    stale = {
        "costs": [{"id": 2370004, "amount": 100}],
        "rewards": [{"type": 0, "id": 11002, "count": 1}],
        "availableFrom": "2024-07-04 12:00:00",
        "availableUntil": "2024-07-30 11:59:59",
        "stock": 10,
        "staleField": True,
    }
    unrelated = {
        "costs": [{"id": 1, "amount": 2}],
        "rewards": [{"type": 0, "id": 3, "count": 4}],
        "availableFrom": "2001-01-01 00:00:00",
        "availableUntil": "2001-01-02 00:00:00",
        "stock": 6,
    }
    event_shop = {
        "11": {
            "700099": {"42": copy.deepcopy(unrelated)},
            "700004": {"700099": copy.deepcopy(stale), "700095": copy.deepcopy(unrelated)},
        },
        "2": {"100006": {"310200": copy.deepcopy(donor)}},
        "9": {"900001": {"700099": copy.deepcopy(stale), "900010": copy.deepcopy(unrelated)}},
    }
    id_map = {
        "900010": {"eventType": 9, "eventId": 900001},
        "700099": {"eventType": 11, "eventId": 700004},
        "42": {"eventType": 11, "eventId": 700099},
        "310200": {"eventType": 2, "eventId": 100006},
    }
    return event_shop, id_map


def expected_product(spec: rewards.WeaponSpec) -> dict:
    price = 15 if spec.element == -1 else 10
    return {
        "costs": [{"id": 2_370_099, "amount": price}],
        "rewards": [{"type": 4, "id": int(spec.id), "count": 1}],
        "availableFrom": "2000-01-01 00:00:00",
        "availableUntil": "2099-12-31 23:59:59",
        "stock": 5,
    }


def assert_numeric_maps_sorted(case: unittest.TestCase, value) -> None:
    if isinstance(value, dict):
        keys = list(value)
        if keys and all(isinstance(key, str) and key.isdigit() for key in keys):
            case.assertEqual(sorted(keys, key=int), keys)
        for child in value.values():
            assert_numeric_maps_sorted(case, child)
    elif isinstance(value, list):
        for child in value:
            assert_numeric_maps_sorted(case, child)


class TestApiReuse(unittest.TestCase):
    def test_weapon_contract_is_reused_without_a_second_definition(self):
        self.assertIs(rewards.WeaponSpec, shop.WeaponSpec)
        self.assertIs(rewards.WEAPONS, shop.WEAPONS)


class TestClientShop(unittest.TestCase):
    def test_builds_exact_fifteen_rows_and_preserves_unrelated_entries(self):
        source = client_fixture()
        original = copy.deepcopy(source)
        result = shop.build_client_shop(source, rewards.WEAPONS)

        self.assertEqual(original, source)
        self.assertNotIn("700099", result)
        self.assertEqual("unrelated-low", result["2"])
        self.assertEqual("unrelated-high", result["9000000"])
        self.assertEqual(original["310200"], result["310200"])
        unrelated_before = [key for key in original if key != "700099"]
        unrelated_after = [key for key in result if key not in SHOP_IDS]
        self.assertEqual(unrelated_before, unrelated_after)
        self.assertEqual(SHOP_IDS, tuple(list(result)[-len(SHOP_IDS):]))
        self.assertEqual(SHOP_IDS, tuple(key for key in result if key in SHOP_IDS))

        donor = template_row()
        for slot, (shop_id, spec) in enumerate(zip(SHOP_IDS, rewards.WEAPONS), start=1):
            row = core.read_csv_lines(result[shop_id])[0]
            self.assertEqual(51, len(row))
            for column, expected in CLIENT_FIELDS.items():
                self.assertEqual(expected, row[column], f"{shop_id} c{column}")
            self.assertEqual(shop_id, row[8])
            self.assertEqual(str(slot), row[10])
            self.assertEqual(spec.name, row[7])
            self.assertEqual(rewards.MODE_DESCRIPTION, row[11])
            self.assertEqual(
                f"{rewards.IMAGE_PREFIX}/{spec.image_slug}", row[13]
            )
            self.assertEqual("5", row[14])
            self.assertEqual("15" if spec.element == -1 else "10", row[19])
            self.assertEqual(spec.id, row[33])
            for column in set(range(51)) - OVERWRITTEN_COLUMNS:
                self.assertEqual(donor[column], row[column], f"{shop_id} c{column}")

    def test_short_template_is_padded_but_overlong_schema_is_rejected(self):
        short = shop.build_client_shop(client_fixture(template_length=35), rewards.WEAPONS)
        self.assertTrue(all(len(core.read_csv_lines(short[key])[0]) == 51 for key in SHOP_IDS))
        with self.assertRaisesRegex(ValueError, "51"):
            shop.build_client_shop(client_fixture(template_length=52), rewards.WEAPONS)

    def test_byte_template_preserves_leaf_type(self):
        source = client_fixture()
        source["310200"] = source["310200"].encode("utf-8")
        result = shop.build_client_shop(source, rewards.WEAPONS)
        self.assertTrue(all(isinstance(result[key], bytes) for key in SHOP_IDS))

    def test_foreign_reserved_occupant_is_rejected_without_mutation(self):
        source = client_fixture()
        source[SHOP_IDS[0]] = "foreign"
        original = copy.deepcopy(source)
        with self.assertRaisesRegex(ValueError, SHOP_IDS[0]):
            shop.build_client_shop(source, rewards.WEAPONS)
        self.assertEqual(original, source)

    def test_second_run_is_idempotent(self):
        first = shop.build_client_shop(client_fixture(), rewards.WEAPONS)
        second = shop.build_client_shop(first, rewards.WEAPONS)
        self.assertEqual(first, second)


class TestServerShop(unittest.TestCase):
    def test_builds_exact_products_and_preserves_unrelated_entries(self):
        event_shop, id_map = server_fixture()
        original_shop = copy.deepcopy(event_shop)
        original_id_map = copy.deepcopy(id_map)
        built_shop, built_map = shop.build_server_shop(event_shop, id_map, rewards.WEAPONS)

        self.assertEqual(original_shop, event_shop)
        self.assertEqual(original_id_map, id_map)
        self.assertEqual(original_shop["2"], built_shop["2"])
        self.assertEqual(original_shop["11"]["700099"]["42"], built_shop["11"]["700099"]["42"])
        self.assertEqual(original_shop["11"]["700004"]["700095"], built_shop["11"]["700004"]["700095"])
        self.assertEqual(original_shop["9"]["900001"]["900010"], built_shop["9"]["900001"]["900010"])
        self.assertNotIn("700099", built_shop["11"]["700004"])
        self.assertNotIn("700099", built_shop["9"]["900001"])
        self.assertNotIn("700099", built_map)

        total = 0
        for shop_id, spec in zip(SHOP_IDS, rewards.WEAPONS):
            product = built_shop["11"]["700099"][shop_id]
            self.assertEqual(expected_product(spec), product)
            self.assertEqual({"eventType": 11, "eventId": 700099}, built_map[shop_id])
            total += product["costs"][0]["amount"] * product["stock"]
        self.assertEqual(825, total)
        assert_numeric_maps_sorted(self, built_shop)
        assert_numeric_maps_sorted(self, built_map)

    def test_second_run_is_json_byte_idempotent(self):
        event_shop, id_map = server_fixture()
        first_shop, first_map = shop.build_server_shop(event_shop, id_map, rewards.WEAPONS)
        second_shop, second_map = shop.build_server_shop(first_shop, first_map, rewards.WEAPONS)
        self.assertEqual(first_shop, second_shop)
        self.assertEqual(first_map, second_map)
        first_bytes = json.dumps(first_shop, ensure_ascii=False, separators=(",", ":"))
        second_bytes = json.dumps(second_shop, ensure_ascii=False, separators=(",", ":"))
        self.assertEqual(first_bytes, second_bytes)

    def test_foreign_reserved_product_or_id_map_is_rejected(self):
        event_shop, id_map = server_fixture()
        event_shop["11"]["700099"][SHOP_IDS[0]] = {"foreign": True}
        with self.assertRaisesRegex(ValueError, SHOP_IDS[0]):
            shop.build_server_shop(event_shop, id_map, rewards.WEAPONS)

        event_shop, id_map = server_fixture()
        id_map[SHOP_IDS[0]] = {"eventType": 2, "eventId": 100006}
        with self.assertRaisesRegex(ValueError, SHOP_IDS[0]):
            shop.build_server_shop(event_shop, id_map, rewards.WEAPONS)

    def test_reserved_product_outside_target_event_is_rejected(self):
        event_shop, id_map = server_fixture()
        event_shop["2"]["100006"][SHOP_IDS[0]] = expected_product(rewards.WEAPONS[0])
        with self.assertRaisesRegex(ValueError, SHOP_IDS[0]):
            shop.build_server_shop(event_shop, id_map, rewards.WEAPONS)


class TestValidation(unittest.TestCase):
    def setUp(self):
        self.client = shop.build_client_shop(client_fixture(), rewards.WEAPONS)
        self.server, self.id_map = shop.build_server_shop(*server_fixture(), rewards.WEAPONS)

    def test_generated_shop_has_no_validation_problems(self):
        self.assertEqual([], shop.validate_shop(self.client, self.server, self.id_map))

    def test_bad_schema_and_wrong_total_cost_are_reported(self):
        bad_client = copy.deepcopy(self.client)
        row = core.read_csv_lines(bad_client[SHOP_IDS[0]])[0][:-1]
        bad_client[SHOP_IDS[0]] = core.write_csv_lines([row])
        bad_server = copy.deepcopy(self.server)
        bad_server["11"]["700099"][SHOP_IDS[0]]["costs"][0]["amount"] = 999
        problems = shop.validate_shop(bad_client, bad_server, self.id_map)
        self.assertTrue(any("51" in problem for problem in problems), problems)
        self.assertTrue(any("825" in problem for problem in problems), problems)


class TestCli(unittest.TestCase):
    def setUp(self):
        self.client = client_fixture()
        self.server, self.id_map = server_fixture()
        self.profile = core.VersionProfile(
            id="cn", label="CN", store=Path("cn-store"), fallback=None
        )
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.target_root = Path(self.temp_dir.name)
        self.client_target = self.target_root / "event_item_shop.orderedmap"
        self.assets_target = self.target_root / "assets"
        self.assets_target.mkdir()
        self.server_target = self.assets_target / shop.SHOP_JSON
        self.id_map_target = self.assets_target / shop.SHOP_ID_MAP_JSON
        self.assets_patch = mock.patch.object(shop, "ASSETS_DIR", self.assets_target)
        self.store_path_patch = mock.patch.object(
            shop.q, "store_path", return_value=self.client_target
        )
        self.assets_patch.start()
        self.store_path_patch.start()
        self.addCleanup(self.assets_patch.stop)
        self.addCleanup(self.store_path_patch.stop)

    def _reset_transaction_targets(self, *, client_exists: bool = True):
        originals = {
            self.client_target: b"client-before\x00\r\n" if client_exists else None,
            self.server_target: b'{\r\n  "before": "shop"\r\n}\r\n',
            self.id_map_target: b'{"before":"id-map"}\n',
        }
        for path, payload in originals.items():
            if path.exists():
                path.unlink()
            if payload is not None:
                path.write_bytes(payload)
        return originals

    def _assert_transaction_targets(self, originals):
        for path, payload in originals.items():
            with self.subTest(target=path.name):
                self.assertEqual(payload is not None, path.exists())
                if payload is not None:
                    self.assertEqual(payload, path.read_bytes())

    def _run_transaction_failure(
        self, failure_at: str, exception_type=OSError,
        errors: io.StringIO | None = None,
    ) -> tuple[int, str]:
        stored_table = copy.deepcopy(self.client)
        stored_json = {
            shop.SHOP_JSON: copy.deepcopy(self.server),
            shop.SHOP_ID_MAP_JSON: copy.deepcopy(self.id_map),
        }
        json_loads = {shop.SHOP_JSON: 0, shop.SHOP_ID_MAP_JSON: 0}

        def load_table(_logical):
            return copy.deepcopy(stored_table)

        def save_table(_logical, data):
            nonlocal stored_table
            stored_table = copy.deepcopy(data)
            self.client_target.write_bytes(b"client-after\n")

        def injected_exception(message):
            if isinstance(exception_type, BaseException):
                return exception_type
            return exception_type(message)

        def load_json(name):
            json_loads[name] += 1
            if json_loads[name] > 1 and failure_at == f"read_{name}":
                raise injected_exception(f"injected {name} readback failure")
            return copy.deepcopy(stored_json[name])

        def save_json(name, data):
            stored_json[name] = copy.deepcopy(data)
            target = self.assets_target / name
            target.write_bytes(
                (json.dumps(data, ensure_ascii=False) + "\n").encode("utf-8")
            )
            if failure_at == f"write_{name}":
                raise injected_exception(f"injected {name} write failure")

        errors = errors if errors is not None else io.StringIO()
        with (
            mock.patch.object(shop, "require_cn_profile", return_value=self.profile),
            mock.patch.object(shop.q, "load_table", side_effect=load_table),
            mock.patch.object(shop.q, "save_table", side_effect=save_table),
            mock.patch.object(shop, "load_json", side_effect=load_json),
            mock.patch.object(shop, "save_json", side_effect=save_json),
            mock.patch.object(sys, "argv", ["wf_rogue_shop.py", "--write"]),
            contextlib.redirect_stderr(errors),
        ):
            result = shop.main()
        return result, errors.getvalue()

    def test_default_is_dry_run_and_does_not_write(self):
        output = io.StringIO()

        def load_json(name):
            return copy.deepcopy(
                self.server if name == "event_item_shop.json" else self.id_map
            )

        with (
            mock.patch.object(shop, "require_cn_profile", return_value=self.profile) as profile,
            mock.patch.object(shop.q, "load_table", return_value=copy.deepcopy(self.client)),
            mock.patch.object(shop.q, "save_table") as save_table,
            mock.patch.object(shop, "load_json", side_effect=load_json),
            mock.patch.object(shop, "save_json") as save_json,
            mock.patch.object(sys, "argv", ["wf_rogue_shop.py"]),
            contextlib.redirect_stdout(output),
        ):
            result = shop.main()

        self.assertEqual(0, result)
        profile.assert_called_once_with()
        save_table.assert_not_called()
        save_json.assert_not_called()
        report = output.getvalue()
        self.assertIn("15 products", report)
        self.assertIn("825", report)
        self.assertIn("700099", report)
        self.assertIn("DRY-RUN", report)

    def test_non_cn_profile_fails_before_reads_or_writes(self):
        with (
            mock.patch.object(shop, "require_cn_profile", side_effect=ValueError("global")),
            mock.patch.object(shop.q, "load_table") as load_table,
            mock.patch.object(shop.q, "save_table") as save_table,
            mock.patch.object(shop, "load_json") as load_json,
            mock.patch.object(shop, "save_json") as save_json,
            mock.patch.object(sys, "argv", ["wf_rogue_shop.py", "--write"]),
        ):
            result = shop.main()

        self.assertNotEqual(0, result)
        load_table.assert_not_called()
        save_table.assert_not_called()
        load_json.assert_not_called()
        save_json.assert_not_called()

    def test_foreign_collision_fails_before_writes(self):
        client = copy.deepcopy(self.client)
        client[SHOP_IDS[0]] = "foreign"

        def load_json(name):
            return copy.deepcopy(
                self.server if name == "event_item_shop.json" else self.id_map
            )

        with (
            mock.patch.object(shop, "require_cn_profile", return_value=self.profile),
            mock.patch.object(shop.q, "load_table", return_value=client),
            mock.patch.object(shop.q, "save_table") as save_table,
            mock.patch.object(shop, "load_json", side_effect=load_json),
            mock.patch.object(shop, "save_json") as save_json,
            mock.patch.object(sys, "argv", ["wf_rogue_shop.py", "--write"]),
        ):
            result = shop.main()

        self.assertNotEqual(0, result)
        save_table.assert_not_called()
        save_json.assert_not_called()

    def test_write_rechecks_profile_and_validates_readback(self):
        stored_table = copy.deepcopy(self.client)
        stored_json = {
            "event_item_shop.json": copy.deepcopy(self.server),
            "event_item_shop_id_map.json": copy.deepcopy(self.id_map),
        }

        def load_table(_logical):
            return copy.deepcopy(stored_table)

        def save_table(_logical, data):
            nonlocal stored_table
            stored_table = copy.deepcopy(data)

        def load_json(name):
            return copy.deepcopy(stored_json[name])

        def save_json(name, data):
            stored_json[name] = copy.deepcopy(data)

        with (
            mock.patch.object(shop, "require_cn_profile", return_value=self.profile) as profile,
            mock.patch.object(shop.q, "load_table", side_effect=load_table),
            mock.patch.object(shop.q, "save_table", side_effect=save_table) as table_write,
            mock.patch.object(shop, "load_json", side_effect=load_json),
            mock.patch.object(shop, "save_json", side_effect=save_json) as json_write,
            mock.patch.object(sys, "argv", ["wf_rogue_shop.py", "--write"]),
        ):
            result = shop.main()

        self.assertEqual(0, result)
        self.assertEqual(2, profile.call_count)
        table_write.assert_called_once_with(shop.SHOP_T, mock.ANY)
        self.assertEqual(2, json_write.call_count)
        self.assertEqual([], shop.validate_shop(stored_table, stored_json["event_item_shop.json"], stored_json["event_item_shop_id_map.json"]))

    def test_corrupt_readback_returns_failure(self):
        built = shop.build_client_shop(self.client, rewards.WEAPONS)
        broken = copy.deepcopy(built)
        broken.pop(SHOP_IDS[-1])
        load_results = [copy.deepcopy(self.client), broken]

        def load_json(name):
            return copy.deepcopy(
                self.server if name == "event_item_shop.json" else self.id_map
            )

        with (
            mock.patch.object(shop, "require_cn_profile", return_value=self.profile),
            mock.patch.object(shop.q, "load_table", side_effect=load_results),
            mock.patch.object(shop.q, "save_table"),
            mock.patch.object(shop, "load_json", side_effect=load_json),
            mock.patch.object(shop, "save_json"),
            mock.patch.object(sys, "argv", ["wf_rogue_shop.py", "--write"]),
        ):
            result = shop.main()

        self.assertNotEqual(0, result)

    def test_reordered_unrelated_client_readback_returns_failure(self):
        built = shop.build_client_shop(self.client, rewards.WEAPONS)
        unrelated = [
            (key, copy.deepcopy(value))
            for key, value in built.items()
            if key not in SHOP_IDS
        ]
        reordered = dict(reversed(unrelated))
        for shop_id in SHOP_IDS:
            reordered[shop_id] = copy.deepcopy(built[shop_id])
        self.assertEqual(built, reordered)
        self.assertNotEqual(list(built.items()), list(reordered.items()))

        stored_json = {
            "event_item_shop.json": copy.deepcopy(self.server),
            "event_item_shop_id_map.json": copy.deepcopy(self.id_map),
        }
        load_results = [copy.deepcopy(self.client), reordered]

        def load_json(name):
            return copy.deepcopy(stored_json[name])

        def save_json(name, data):
            stored_json[name] = copy.deepcopy(data)

        with (
            mock.patch.object(shop, "require_cn_profile", return_value=self.profile),
            mock.patch.object(shop.q, "load_table", side_effect=load_results),
            mock.patch.object(shop.q, "save_table"),
            mock.patch.object(shop, "load_json", side_effect=load_json),
            mock.patch.object(shop, "save_json", side_effect=save_json),
            mock.patch.object(sys, "argv", ["wf_rogue_shop.py", "--write"]),
        ):
            result = shop.main()

        self.assertNotEqual(0, result)

    def test_second_and_third_write_failures_restore_exact_targets(self):
        cases = (
            (f"write_{shop.SHOP_JSON}", True),
            (f"write_{shop.SHOP_ID_MAP_JSON}", False),
        )
        for failure_at, client_exists in cases:
            with self.subTest(failure_at=failure_at):
                originals = self._reset_transaction_targets(
                    client_exists=client_exists
                )
                result, errors = self._run_transaction_failure(failure_at)
                self.assertEqual(1, result)
                self.assertIn("injected", errors)
                self._assert_transaction_targets(originals)

    def test_second_and_third_readback_failures_restore_exact_targets(self):
        for name in (shop.SHOP_JSON, shop.SHOP_ID_MAP_JSON):
            failure_at = f"read_{name}"
            with self.subTest(failure_at=failure_at):
                originals = self._reset_transaction_targets()
                result, errors = self._run_transaction_failure(failure_at)
                self.assertEqual(1, result)
                self.assertIn("injected", errors)
                self._assert_transaction_targets(originals)

    def test_unexpected_write_exception_still_restores_exact_targets(self):
        originals = self._reset_transaction_targets()
        result, errors = self._run_transaction_failure(
            f"write_{shop.SHOP_JSON}", LookupError
        )
        self.assertEqual(1, result)
        self.assertIn("injected", errors)
        self._assert_transaction_targets(originals)

    def test_rollback_failure_is_reported_alongside_original_error(self):
        self._reset_transaction_targets()
        with mock.patch.object(
            shop._FileBeforeImages,
            "restore",
            return_value=["injected rollback failure"],
        ):
            result, errors = self._run_transaction_failure(
                f"write_{shop.SHOP_JSON}"
            )
        self.assertEqual(1, result)
        self.assertIn("injected event_item_shop.json write failure", errors)
        self.assertIn("回滚失败", errors)
        self.assertIn("injected rollback failure", errors)

    def test_cancelled_late_operations_restore_exact_targets_before_reraise(self):
        cases = (
            (
                f"write_{shop.SHOP_ID_MAP_JSON}",
                KeyboardInterrupt("cancel third write"),
                False,
            ),
            (
                f"read_{shop.SHOP_ID_MAP_JSON}",
                SystemExit("cancel third readback"),
                True,
            ),
        )
        for failure_at, cancellation, client_exists in cases:
            with self.subTest(failure_at=failure_at):
                originals = self._reset_transaction_targets(
                    client_exists=client_exists
                )
                errors = io.StringIO()
                with self.assertRaises(type(cancellation)) as caught:
                    self._run_transaction_failure(
                        failure_at, cancellation, errors
                    )
                self.assertIs(cancellation, caught.exception)
                self._assert_transaction_targets(originals)
                self.assertIn("ROLLBACK", errors.getvalue())

    def test_cancelled_operation_reports_rollback_failure_before_reraise(self):
        self._reset_transaction_targets()
        cancellation = KeyboardInterrupt("cancel third write")
        errors = io.StringIO()
        with mock.patch.object(
            shop._FileBeforeImages,
            "restore",
            return_value=["injected cancellation rollback failure"],
        ):
            with self.assertRaises(KeyboardInterrupt) as caught:
                self._run_transaction_failure(
                    f"write_{shop.SHOP_ID_MAP_JSON}", cancellation, errors
                )
        self.assertIs(cancellation, caught.exception)
        self.assertIn("回滚失败", errors.getvalue())
        self.assertIn("injected cancellation rollback failure", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
